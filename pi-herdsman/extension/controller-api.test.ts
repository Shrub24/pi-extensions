import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "node:test";
import { Value } from "typebox/value";
import { DELEGATION_BRIEF_EXAMPLES, parseDelegationBrief } from "./briefs.ts";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { OperationError } from "./errors.ts";
import { createRadarClient } from "./radar-client.ts";
import { classifySupervisedLead } from "./presentation.ts";
import { readProcessBirth } from "./radar-publication.ts";
import { RADAR_SUBJECT_SOURCE } from "./radar-execution.ts";
import { resultPath, resultRef } from "./storage.ts";
import {
  listChiefMessagePaths,
  readChiefMessage,
  readChiefDescriptor,
  supervisionRuntime,
  claimChiefLease,
  writeChiefMessage,
  writeLeadCoordinationState,
} from "./supervision.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  controlMarker,
  defaultFixtureIdentity,
  discoverAgent,
  fakeContext,
  fakePi,
  fakeAgentContext,
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
  removeAsk,
  removeRequest,
  removeResult,
  resetAgentMailbox,
  resolveAssignmentSession,
  setLeadEnvironment,
  setAgentEnvironment,
  radarDaemon,
  radarObservedFleet,
  drainRadarObserves,
  settleRadarObserves,
  spawnedArgvs,
  startRadarSession,
  agentMailboxPath,
  writeAsk,
  writePromptDefinition,
  writeRequest,
  writeResult,
  writeAgentState,
  testChildCommand,
  testTmpRoot,
} from "./support.ts";
async function registerStandaloneRadarAgent(
  piSessionId: string,
  pane: string,
  activity?: { value: string; observedAt?: string },
): Promise<string> {
  const client = createRadarClient({ env: process.env });
  const incarnation = randomUUID();
  const birth = readProcessBirth();
  if (birth === undefined) throw new Error("the fixture process identity is unavailable");
  const registration = await client.register({
    source: RADAR_SUBJECT_SOURCE,
    incarnation,
    session: piSessionId,
    location: { backend: "tmux", instance: "herdsman-fixture", pane },
    process: birth,
  });
  if (!registration.ok) throw new Error(`standalone registration failed: ${registration.message}`);
  const proof = await client.agentGet(registration.value.agent_id);
  if (!proof.ok) throw new Error(`standalone registration proof failed: ${proof.message}`);
  assert.equal(proof.value.verification, "verified");
  assert.equal(proof.value.contextSession, piSessionId);
  assert.equal(proof.value.location?.pane, pane);
  if (activity !== undefined) {
    const publisher = { source: RADAR_SUBJECT_SOURCE, incarnation };
    const writer = await client.acquire({
      agent_id: registration.value.agent_id,
      channel: "execution",
      publisher,
    });
    if (!writer.ok) throw new Error(`standalone publisher acquisition failed: ${writer.message}`);
    const publication = await client.publish({
      agent_id: registration.value.agent_id,
      channel: "execution",
      writer_handle: writer.value.handle,
      sequence: writer.value.sequence,
      observed_at: activity.observedAt ?? new Date().toISOString(),
      snapshot: { activity: activity.value },
    });
    if (!publication.ok) throw new Error(`standalone publication failed: ${publication.message}`);
    const read = await client.agentGet(registration.value.agent_id);
    if (!read.ok) throw new Error(`standalone publication read failed: ${read.message}`);
    const expectedActivity = activity.observedAt !== undefined &&
      Date.now() - Date.parse(activity.observedAt) > 30_000
      ? undefined
      : activity.value;
    assert.equal(read.value.activity, expectedActivity);
  }
  return registration.value.agent_id;
}

function fakeChiefPi(options: Parameters<typeof fakePi>[0] = {}) {
  let fixture: ReturnType<typeof fakePi>;
  const initialTools = Array.isArray(options.activeTools)
    ? options.activeTools
    : [];
  fixture = fakePi({
    ...options,
    allTools: () =>
      [
        ...new Set([
          ...initialTools,
          "read",
          "bash",
          "agent",
          "supervisor",
          "peer",
          "staff",
          ...fixture.tools.map((tool) => tool.name),
        ]),
      ].map((name) => ({ name })),
  });
  return fixture;
}
const { updateConfig } = await import("./config.ts");
function testBrief(task: string, profile: keyof typeof DELEGATION_BRIEF_EXAMPLES): string {
  return `${DELEGATION_BRIEF_EXAMPLES[profile].trimEnd()}\n\nAssignment-specific detail:\n${task}`;
}
const agentTool = (pi: ReturnType<typeof fakePi>, name: string) => {
  const tool = pi.tools.find((candidate) => candidate.name === `agent_${name}`)!;
  if (name !== "delegate" && name !== "continue" && name !== "interrupt")
    return tool;
  return {
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      const params = args[1] as Record<string, unknown> | undefined;
      const field = name === "interrupt" ? "message" : "task";
      const task = params?.[field];
      if (typeof task !== "string" || task.trimStart().startsWith("---"))
        return tool.execute(...args);
      const label = typeof params.agent === "string" ? params.agent : "";
      const storedProfile =
        name === "interrupt" && label
          ? readAgentState(agentMailboxPath(WORKSPACE, label))?.briefProfile
          : undefined;
      const definition = typeof params.definition === "string" ? params.definition : "";
      const profile = storedProfile ?? (definition.includes("review")
        ? "review"
        : definition.includes("research")
          ? "research"
          : definition.includes("investig")
            ? "investigation"
            : definition.includes("implement") || definition.includes("execut")
              ? "execution"
              : "common");
      const next = [...args] as Parameters<typeof tool.execute>;
      next[1] = { ...params, [field]: testBrief(task, profile) } as never;
      return tool.execute(...next);
    },
  };
};
const ownershipResult = (
  child: string,
  owner = LEAD_SESSION_ID,
  options: { path?: string; label?: string; definition?: string } = {},
) => ({
  type: "custom_message",
  customType: "pi-herdsman-agent-result",
  content: "",
  display: true,
  details: {
    piSessionId: child,
    ...(options.path ? { piSessionFile: options.path } : {}),
    ownerSessionId: owner,
    runId: randomUUID(),
    requestId: randomUUID(),
    agentLabel: options.label ?? "agent",
    agentDefinition: options.definition ?? "agent",
    status: "completed",
  },
});

test("unassigned Lead routes supervisor messages directly to Chief", async () => {
  setLeadEnvironment();
  const chiefId = randomUUID();
  const leadId = randomUUID();
  const chiefAgentId = await registerStandaloneRadarAgent(
    chiefId,
    "tmux:herdsman-fixture:%2",
  );
  const runtime = supervisionRuntime();
  const chief = claimChiefLease({
    piSessionId: chiefId,
    paneId: "tmux:herdsman-fixture:%2",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
    agentId: chiefAgentId,
  });
  const pi = fakeChiefPi();
  registerExtension!(pi.pi as never);
  const ctx = fakeContext() as any;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => leadId,
    getSessionFile: () => `/tmp/${leadId}.jsonl`,
  };
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    const result = await pi.tools
      .find((tool) => tool.name === "supervisor_message")!
      .execute("message", { message: "UNASSIGNED_DIRECT_TO_CHIEF" }, undefined, undefined, ctx);
    assert.equal(result.details.chiefSessionId, chiefId);
    assert.ok(
      listChiefMessagePaths(runtime, chiefId).some((path) => {
        const record = readChiefMessage(path);
        return record.kind === "lead_message" && record.fromSessionId === leadId &&
          record.text === "UNASSIGNED_DIRECT_TO_CHIEF";
      }),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    chief.release();
    setLeadEnvironment();
  }
});

test("legacy Lead pendingAsk state is normalized and does not block messaging", async () => {
  setLeadEnvironment();
  const chiefId = randomUUID();
  const leadId = randomUUID();
  const chiefAgentId = await registerStandaloneRadarAgent(
    chiefId,
    "tmux:herdsman-fixture:%2",
  );
  const runtime = supervisionRuntime();
  const chief = claimChiefLease({
    piSessionId: chiefId,
    paneId: "tmux:herdsman-fixture:%2",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
    agentId: chiefAgentId,
  });
  const pi = fakeChiefPi({
    entries: [{ type: "custom", customType: "pi-herdsman-lead-state", data: {
      instanceId: randomUUID(), pendingAsk: { question: "retired question", id: randomUUID() },
    } }],
  });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext(pi.entries) as any;
  ctx.sessionManager = { ...ctx.sessionManager, getSessionId: () => leadId };
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    const normalized = pi.entries
      .filter((entry: any) => entry?.customType === "pi-herdsman-lead-state")
      .at(-1) as any;
    assert.deepEqual(Object.keys(normalized.data).sort(), ["instanceId", "sessionId"]);
    assert.equal(normalized.data.sessionId, leadId);
    assert.notEqual(normalized.data.instanceId, (pi.entries[0] as any).data.instanceId);

    const result = await pi.tools
      .find((tool) => tool.name === "supervisor_message")!
      .execute("message", { message: "LEGACY_STATE_MESSAGE_OK" }, undefined, undefined, ctx);
    assert.equal(result.details.chiefSessionId, chiefId);
    assert.ok(
      listChiefMessagePaths(runtime, chiefId).some((path) => {
        const record = readChiefMessage(path);
        return record.kind === "lead_message" && record.fromSessionId === leadId &&
          record.text === "LEGACY_STATE_MESSAGE_OK";
      }),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    chief.release();
    setLeadEnvironment();
  }
});

test("a Chief's supervision lists a Lead only when the Radar registry proves it", async () => {
  setLeadEnvironment();
  const chiefSession = randomUUID();
  const leadSession = randomUUID();
  const unprovenSession = randomUUID();
  const leadAgentId = await registerStandaloneRadarAgent(
    leadSession,
    "tmux:herdsman-fixture:%2",
  );
  const unprovenAgentId = await registerStandaloneRadarAgent(
    unprovenSession,
    "tmux:herdsman-fixture:%3",
  );
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: leadSession,
    agentId: leadAgentId,
    paneId: "tmux:herdsman-fixture:%2",
    workspaceId: WORKSPACE,
    tabId: "lead-tab",
    updatedAt: Date.now(),
  });
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: unprovenSession,
    agentId: unprovenAgentId,
    // The registration is real, but this persisted record names another pane.
    paneId: "tmux:herdsman-fixture:%4",
    workspaceId: WORKSPACE,
    tabId: "unproven-tab",
    updatedAt: Date.now(),
  });
  const pi = fakeChiefPi();
  registerExtension!(pi.pi as never);
  const ctx = fakeContext() as any;
  ctx.sessionManager = { ...ctx.sessionManager, getSessionId: () => chiefSession };
  ctx.isIdle = () => true;
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("chief").handler("", ctx);
    const started: any = await pi.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      ctx,
    );
    const supervision = JSON.stringify(started.message);
    assert.ok(supervision.includes(leadSession));
    assert.equal(supervision.includes(unprovenSession), false);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    setLeadEnvironment();
  }
});

test("project agent discovery is gated by Pi project trust", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-gate-"),
  );
  let pi: ReturnType<typeof fakePi> | undefined;
  try {
    const agents = join(project, ".pi", "agents");
    realFs.mkdirSync(agents, { recursive: true });
    realFs.writeFileSync(
      join(agents, "project-only.md"),
      "---\nname: project-only\n---\nproject policy",
    );
    pi = fakePi();
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.cwd = project;
    context.hasUI = true;
    context.mode = "rpc";
    const selections: string[][] = [];
    context.ui.select = async (_title: string, options: string[]) => {
      selections.push(options);
      return undefined;
    };
    await command.handler("definitions", context);
    assert.equal(
      selections.at(-1)?.some((value) => value.includes("project-only")),
      true,
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "project-only.md"),
      "---\nname: project-only\nmodel: global/model\n---\nglobal policy",
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "standalone-global.md"),
      "---\nname: standalone-global\n---\nglobal",
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "scout.md"),
      "---\nname: scout\nmodel: global/model\n---\nglobal",
    );
    await command.handler("definitions", context);
    const options = selections.at(-1) ?? [];
    assert.ok(
      options.some((value) => value.startsWith("project-only [project] *")),
    );
    assert.ok(options.some((value) => value.startsWith("scout *")));
    assert.ok(options.some((value) => value.startsWith("standalone-global")));
    assert.equal(
      options.some((value) => value.startsWith("standalone-global *")),
      false,
    );
    realFs.rmSync(join(PI_AGENTS_DIR, "project-only.md"), { force: true });
    context.isProjectTrusted = () => false;
    await command.handler("definitions", context);
    assert.equal(
      selections.at(-1)?.some((value) => value.includes("project-only")),
      false,
    );
  } finally {
    pi?.events.get("session_shutdown")?.[0]();
    realFs.rmSync(project, { recursive: true, force: true });
    for (const name of ["project-only.md", "standalone-global.md", "scout.md"])
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
    setLeadEnvironment();
  }
});

test("semantic result refs attach persisted output and preserve canonical file refs", async () => {
  setLeadEnvironment();
  const requestId = randomUUID();
  const canonical = resultRef(requestId);
  const resultFile = resultPath(requestId);
  const resultText = [
    'Agent result source: {"agent":"implementation","definition":"agent","cwd":"/repo","piSessionId":"producer-session"}',
    "persisted implementation review",
  ].join("\n\n");
  realFs.mkdirSync(resolve(resultFile, ".."), { recursive: true });
  realFs.writeFileSync(resultFile, resultText, "utf8");
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: {
        agentLabel: "implementation",
        resultIndex: 1,
        requestId,
        resultRef: canonical,
        status: "completed",
      },
    },
  ];
  const label = "agent";
  let assignedText = "";
  // The Radar child the delegate launches receives the assignment itself.
  radarDaemon.onChildRequest = (_spawn, request) => {
    assignedText = request.text;
  };
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "Review supplied implementation.",
        files: ["result:implementation#1", canonical],
      },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.match(assignedText, new RegExp(`<file name="${canonical}"`));
    assert.match(
      assignedText,
      /Agent result source: \{"agent":"implementation","definition":"agent","cwd":"\/repo","piSessionId":"producer-session"\}/,
    );
    assert.match(assignedText, /persisted implementation review/);
    assert.equal(
      assignedText.match(new RegExp(`<file name="${canonical}"`, "g"))?.length,
      1,
      "semantic and canonical refs supplied through files should deduplicate in the existing pipeline",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
    realFs.rmSync(resultFile, { force: true });
  }
});

test("advertised result refs resolve as accepted context inputs", async () => {
  setLeadEnvironment();
  const requestId = randomUUID();
  const canonical = resultRef(requestId);
  const resultFile = resultPath(requestId);
  const resultText = "persisted context input evidence";
  realFs.mkdirSync(resolve(resultFile, ".."), { recursive: true });
  realFs.writeFileSync(resultFile, resultText, "utf8");
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: {
        agentLabel: "implementation",
        resultIndex: 1,
        requestId,
        resultRef: canonical,
        status: "completed",
      },
    },
  ];
  const label = "agent";
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const brief = DELEGATION_BRIEF_EXAMPLES.common.replace(
    "  inputs: []",
    "  inputs:\n    - reference: result:implementation#1\n      purpose: required context",
  );
  try {
    const malformed = await agentTool(pi, "delegate").execute(
      "malformed",
      {
        definition: "agent",
        task: brief.replace("result:implementation#1", "result:implementation#01"),
      },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(malformed.details.error.category, "invalid_request");
    assert.equal(
      malformed.details.error.message,
      "Invalid result ref: result:implementation#01. Copy the exact result ref shown by the agent completion.",
    );

    const result = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", task: brief },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
    realFs.rmSync(resultFile, { force: true });
  }
});

test("semantic result refs resolve only on the active branch", async () => {
  setLeadEnvironment();
  const requestId = randomUUID();
  const resultEntry = {
    customType: "pi-herdsman-agent-result",
    details: {
      agentLabel: "implementation",
      resultIndex: 2,
      requestId,
      resultRef: resultRef(requestId),
      status: "completed",
    },
  };
  const entries: unknown[] = [resultEntry];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "must not start",
        files: ["result:implementation#2"],
      },
      undefined,
      undefined,
      fakeContext(entries, []),
    );
    assert.equal(result.details.error.category, "target_not_found");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
    const malformed = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "must not start",
        files: ["result:implementation#01"],
      },
      undefined,
      undefined,
      fakeContext(entries, []),
    );
    assert.equal(malformed.details.error.category, "invalid_request");
    assert.equal(
      malformed.details.error.message,
      "Invalid result ref: result:implementation#01. Copy the exact result ref shown by the agent completion.",
    );
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("conflicting duplicate result mappings fail closed", async () => {
  setLeadEnvironment();
  const firstRequestId = randomUUID();
  const secondRequestId = randomUUID();
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: {
        agentLabel: "implementation",
        resultIndex: 1,
        requestId: firstRequestId,
        resultRef: resultRef(firstRequestId),
        status: "completed",
      },
    },
    {
      customType: "pi-herdsman-agent-result",
      details: {
        agentLabel: "implementation",
        resultIndex: 1,
        requestId: secondRequestId,
        resultRef: resultRef(secondRequestId),
        status: "completed",
      },
    },
  ];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "must not guess",
        files: ["result:implementation#1"],
      },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("managed agent validates project definitions before publishing state", async () => {
  const mailbox = setAgentEnvironment("project-validation-agent");
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-agent-project-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "agents", "broken.md"),
    '---\nname: broken-parent\nagents: ["missing-child"]\n---\nbroken',
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "project-parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "project-parent",
      },
    },
  ]) as any;
  context.cwd = project;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(project, { recursive: true, force: true });
  }
});

test("trusted same-cwd project assignment launches with native approval", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-assign-same-cwd-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-only.md"),
    "---\nname: project-only\n---\nproject",
  );
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = project;
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "project-only",
        task: "same cwd",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      result.details.ok,
      true,
      JSON.stringify({ result: result.details, entries: pi.entries }),
    );
    assert.ok(spawnedArgvs(radarDaemon)[0]?.includes("--approve"));
    const tool = pi.tools.find((candidate) => candidate.name === "agent_steer");
    const rendered = tool.renderCall(
      { agent: result.details.agent, message: "Continue." },
      {
        fg: (_color: string, value: string) => value,
        bold: (text: string) => text,
      },
      { argsComplete: true },
    );
    assert.match(rendered.render(160).join("\n"), /agent steer\s+project-only/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "project-only"));
    realFs.rmSync(project, { recursive: true, force: true });
  }
  await (async () => {
    setLeadEnvironment();
    const project = realFs.mkdtempSync(
      join(tmpdir(), "pi-herdsman-assign-symlink-cwd-"),
    );
    const projectLink = `${project}-link`;
    realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    realFs.writeFileSync(
      join(project, ".pi", "agents", "project-only.md"),
      "---\nname: project-only\n---\nproject",
    );
    realFs.symlinkSync(project, projectLink);
    const pi = fakePi({});
    registerExtension!(pi.pi as never);
    const context = fakeContext() as any;
    context.cwd = projectLink;
    try {
      const result = await agentTool(pi, "delegate").execute(
        "id",
        { definition: "project-only", task: "symlink cwd" },
        undefined,
        undefined,
        context,
      );
      assert.equal(
        result.details.ok,
        true,
        JSON.stringify({ result: result.details, entries: pi.entries }),
      );
      assert.ok(spawnedArgvs(radarDaemon)[0]?.includes("--approve"));
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(agentMailboxPath(WORKSPACE, "project-only"));
      realFs.rmSync(projectLink, { force: true });
      realFs.rmSync(project, { recursive: true, force: true });
    }
  })();
});

test("untrusted assignments omit project approval", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-approval-untrusted-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = project;
  context.isProjectTrusted = () => false;
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "untrusted",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(
      spawnedArgvs(radarDaemon)[0]?.includes("--approve"),
      false,
      "an untrusted project is launched without approval",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "agent"));
    realFs.rmSync(project, { recursive: true, force: true });
  }
});

test("project-only Definitions edits create a global override", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-edit-"),
  );
  const projectPath = join(project, ".pi", "agents", "project-only.md");
  const original = "---\nname: project-only\n---\nproject policy\n";
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(projectPath, original);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.cwd = project;
  context.hasUI = true;
  context.mode = "rpc";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "provider", id: "edited-model" }],
    getAvailable: () => [{ provider: "provider", id: "edited-model" }],
  };
  let selection = 0;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("project-only"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return "edited-model";
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    const globalPath = join(PI_AGENTS_DIR, "project-only.md");
    assert.equal(realFs.readFileSync(projectPath, "utf8"), original);
    assert.match(
      realFs.readFileSync(globalPath, "utf8"),
      /^model: provider\/edited-model$/m,
    );
    const effective = discoverAgent("project-only", { projectRoot: project });
    assert.equal(effective.frontmatter.model, "provider/edited-model");
    assert.equal(effective.projectSource, projectPath);
    assert.equal(effective.overrideSource, globalPath);
    realFs.rmSync(globalPath, { force: true });
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(project, { recursive: true, force: true });
    realFs.rmSync(join(PI_AGENTS_DIR, "project-only.md"), { force: true });
  }
});

test("same-cwd managed parents resolve project children", async () => {
  setAgentEnvironment("project-parent", ["project-child"]);
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-parent-project-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-parent.md"),
    '---\nname: project-parent\nagents: ["project-child"]\n---\nparent',
  );
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-child.md"),
    "---\nname: project-child\n---\nchild",
  );
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "project-parent";
  const parent = { ...managedState("project-parent"), cwd: project };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "project-parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "project-parent",
      },
    },
  ]) as any;
  context.cwd = project;
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const started = await agentTool(pi, "delegate").execute(
      "start",
      {
        definition: "project-child",
        task: "delegate project child work",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(started.details.ok, true, JSON.stringify(started.details));
    const childState = readAgentState(
      agentMailboxPath(WORKSPACE, "project-child"),
    );
    assert.equal(childState?.ownerSessionId, parent.piSessionId);
    assert.equal(childState?.cwd, project);
    const child = discoverAgent("project-child", { projectRoot: project });
    assert.equal(
      child.projectSource,
      join(project, ".pi", "agents", "project-child.md"),
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "project-child"));
    realFs.rmSync(project, { recursive: true, force: true });
    setLeadEnvironment();
  }
});

test("parent controller readiness and allowlist fail closed", async () => {
  setAgentEnvironment("delegating-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("delegating-parent");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  // The mailbox pane is the process's own raw pane, which is what its own
  // environment declares.
  writeAgentState(parentMailbox, parent);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
    ["other.md", "---\nname: other\n---\nother\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const context = fakeAgentContext([
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
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const tool = agentTool(pi, "delegate");
  try {
    const beforeInit = await tool.execute(
      "id",
      { definition: "child", task: "before init" },
      undefined,
      undefined,
      context,
    );
    assert.equal(beforeInit.details.error.category, "target_not_found");
    assert.equal(pi.calls.length, 0);

    const listBeforeInit = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(listBeforeInit.details.error.category, "target_not_found");
    assert.equal(pi.calls.length, 0);

    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    const unauthorized = await tool.execute(
      "id",
      { definition: "other", task: "not allowed" },
      undefined,
      undefined,
      context,
    );
    assert.equal(unauthorized.details.error.category, "invalid_request");
    assert.equal(
      unauthorized.details.error.message,
      "Agent definition other is not allowed for this delegating agent",
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }

  setAgentEnvironment("conflicting-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const conflict = managedState("conflicting-parent");
  const conflictMailbox = agentMailboxPath(WORKSPACE, conflict.agentLabel);
  resetAgentMailbox(conflictMailbox);
  writeAgentState(conflictMailbox, {
    ...conflict,
    runId: "11111111-1111-4111-8111-111111111111",
  });
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const failing = fakePi({});
  registerExtension!(failing.pi as never);
  const failingContext = fakeAgentContext([
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
  try {
    for (const handler of failing.events.get("session_start") ?? [])
      await handler(undefined, failingContext);
    const launchesBefore = spawnedArgvs(radarDaemon).length;
    const rejected = await agentTool(failing, "delegate").execute(
      "id",
      { definition: "child", task: "conflicting state" },
      undefined,
      undefined,
      failingContext,
    );
    assert.equal(rejected.details.error.category, "target_not_found");
    assert.equal(spawnedArgvs(radarDaemon).length, launchesBefore);
  } finally {
    for (const handler of failing.events.get("session_shutdown") ?? [])
      handler();
    resetAgentMailbox(conflictMailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("parent list hides disabled allowed definitions", async () => {
  setAgentEnvironment("listing-parent", ["enabled-child", "disabled-child"]);
  const files = [
    ["enabled-child.md", "---\nname: enabled-child\n---\nchild\n"],
    [
      "disabled-child.md",
      "---\nname: disabled-child\nenabled: false\n---\nchild\n",
    ],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const entries = pi.entries;
  const context = fakeAgentContext(entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const listed = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(
      (listed.details.agent_definitions as { name: string }[]).map(
        ({ name }) => name,
      ),
      ["enabled-child"],
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const [name] of files)
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
  }
});

test("parent list omits unrelated unknown mailbox diagnostics", async () => {
  setAgentEnvironment("recovery-parent-no-self-get", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("recovery-parent-no-self-get");
  const child = {
    ...managedState(
      "recovered-child",
      undefined,
      recoveryIdentity("recovered-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/recovered-child.jsonl",
  };
  const mailboxes = [parent, child].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  const unknownMailbox = agentMailboxPath(
    "unrelated-workspace",
    "unrelated-agent",
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  writeAgentState(mailboxes[0], parent);
  writeAgentState(mailboxes[1], child);
  realFs.mkdirSync(unknownMailbox, { recursive: true });
  realFs.writeFileSync(join(unknownMailbox, "state.json"), "{malformed");
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  // Every mailbox this subject needs is written above, so the setup below lives
  // inside the try: a stimulus failure must not leave the malformed record this
  // test plants for the rest of the file.
  let pi: ReturnType<typeof fakePi> | undefined;
  try {
    pi = fakePi({});
    registerExtension!(pi.pi as never);
    const context = fakeAgentContext([
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
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    const listed = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      (listed.details.agents as { agent?: string }[])
        .map((agent) => agent.agent)
        .filter((agent): agent is string => agent !== undefined),
      [child.agentLabel],
    );
    // A mailbox nothing launched is unknown on its own facts; what this subject
    // holds is that the unrelated workspace's record never reaches the list.
    assert.equal(
      (listed.details.agents as { agent?: string }[]).some(
        (agent) => agent.agent === "unrelated-agent",
      ),
      false,
    );
    // The listed child names its own absent proof; the unrelated workspace's
    // record must not appear in this list at all.
    const shown = (listed.content[0] as { text: string }).text;
    assert.doesNotMatch(shown, /unrelated-workspace|unrelated-agent/);
  } finally {
    for (const handler of pi?.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    realFs.rmSync(unknownMailbox, { recursive: true, force: true });
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("foreign-workspace mailbox is ignored by recovery and list", async () => {
  setLeadEnvironment();
  const label = "cross-workspace-agent";
  const identity = recoveryIdentity(label);
  const current = managedState(label, undefined, identity);
  const foreign: ManagedAgentState = {
    ...current,
    workspaceId: "foreign-workspace",
    paneId: "foreign-pane",
    piSessionFile: "/tmp/foreign-workspace-agent.jsonl",
  };
  const currentMailbox = agentMailboxPath(WORKSPACE, label);
  const foreignMailbox = agentMailboxPath(foreign.workspaceId, label);
  resetAgentMailbox(currentMailbox);
  resetAgentMailbox(foreignMailbox);
  writeAgentState(currentMailbox, current);
  writeAgentState(foreignMailbox, foreign);
  const entries: unknown[] = [];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);

  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      (listed.details.agents as { agent?: string }[])
        .map((agent) => agent.agent)
        .filter((agent): agent is string => agent !== undefined),
      [label],
    );
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_recovery_error",
      ),
      false,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(currentMailbox);
    resetAgentMailbox(foreignMailbox);
  }
});

test("list retains durable agents whose physical identity is not exact", async () => {
  setLeadEnvironment();
  const validLabel = "valid-list-agent";
  const invalidLabel = "invalid-list-agent";
  const valid = recoveryIdentity(validLabel);
  const invalid = {
    ...recoveryIdentity(invalidLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const validMailbox = agentMailboxPath(WORKSPACE, validLabel);
  const invalidMailbox = agentMailboxPath(WORKSPACE, invalidLabel);
  resetAgentMailbox(validMailbox);
  resetAgentMailbox(invalidMailbox);
  writeAgentState(validMailbox, managedState(validLabel, undefined, valid));
  writeAgentState(
    invalidMailbox,
    managedState(invalidLabel, undefined, invalid),
  );
  nativeSessions.set(invalid.piSessionId, {
    id: invalid.piSessionId,
    path: invalid.piSessionFile,
    entries: [],
  });
  nativeSessions.set(valid.piSessionId, {
    id: valid.piSessionId,
    path: valid.piSessionFile,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: valid.piSessionId,
          definition: "agent",
          label: "agent",
        },
      },
    ],
  });
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
                agents: [
                  {
                    name: "unmanaged-agent",
                    agent_status: "idle",
                    workspace_id: WORKSPACE,
                    pane_id: "unmanaged-pane",
                    cwd: "/tmp",
                  },
                  {
                    agent_status: "idle",
                    workspace_id: WORKSPACE,
                    pane_id: invalid.paneId,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: DEFAULT_PI_SESSION_ID,
                    },
                  },
                  {
                    agent_status: "idle",
                    workspace_id: WORKSPACE,
                    pane_id: valid.paneId,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: valid.piSessionId,
                    },
                    agent_definition: "wrong-herdr-definition",
                  },
                ],
                panes: [
                  {
                    pane_id: "unmanaged-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                  },
                  {
                    pane_id: invalid.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                  },
                  {
                    pane_id: valid.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                  },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: [
                {
                  pane_id: "unmanaged-pane",
                  workspace_id: WORKSPACE,
                  agent: "unmanaged-agent",
                  agent_status: "unknown",
                },
                {
                  pane_id: invalid.paneId,
                  workspace_id: WORKSPACE,
                  agent: invalidLabel,
                  agent_status: "idle",
                },
                {
                  pane_id: valid.paneId,
                  workspace_id: WORKSPACE,
                  agent: validLabel,
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
  try {
    registerExtension!(pi.pi as never);
    const result = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const agents = (
      result.details as { agents: Array<Record<string, unknown>> }
    ).agents;
    assert.deepEqual(
      agents
        .filter((agent) => typeof agent.agent === "string")
        .map((agent) => agent.agent)
        .sort(),
      [invalidLabel, validLabel].sort(),
    );
    const invalidAgent = agents.find((agent) => agent.agent === invalidLabel);
    const validAgent = agents.find((agent) => agent.agent === validLabel);
    assert.ok(invalidAgent);
    assert.ok(validAgent);
    assert.equal(invalidAgent.state, "unknown");
    assert.deepEqual(invalidAgent.available_tools, []);
    assert.equal(validAgent.agent_definition, "agent");
    assert.equal(validAgent.managed, true);
  } finally {
    nativeSessions.delete(invalid.piSessionId);
    nativeSessions.delete(valid.piSessionId);
    resetAgentMailbox(validMailbox);
    resetAgentMailbox(invalidMailbox);
  }
});

test("list projects an unreadable current mailbox as non-actionable unknown", async () => {
  setLeadEnvironment();
  const mailbox = agentMailboxPath(WORKSPACE, "unreadable-list-agent");
  realFs.mkdirSync(mailbox, { recursive: true });
  realFs.writeFileSync(join(mailbox, "state.json"), "x".repeat(70 * 1024));
  const pi = fakePi({
    exec: (_command, args) =>
      isAgentList(args) || isApiSnapshot(args)
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
  try {
    const result = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.agents.length, 1);
    assert.deepEqual(
      { ...result.details.agents[0], diagnostic: undefined },
      {
        state: "unknown",
        available_tools: [],
        managed: true,
        diagnostic: undefined,
      },
    );
    assert.match(
      result.details.agents[0].diagnostic,
      /Mailbox state unavailable: .*Mailbox record is too large/,
    );
    assert.match(
      (result.content[0] as { text: string }).text,
      /diagnostic: Mailbox state unavailable: .*Mailbox record is too large/,
    );
    assert.doesNotMatch(
      (result.content[0] as { text: string }).text,
      /session:|pane:/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
  }
});

test("assignment session resolution accepts exact paths and UUIDs only", async () => {
  const name = `native-resume-${randomUUID()}.jsonl`;
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ab",
    path: join(homedir(), name),
    cwd: join(homedir(), "saved-agent"),
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "018f2f2e-7b13-7abc-8def-0123456789ab",
          definition: "reviewer",
          label: "review-fix",
        },
      },
    ],
  };
  nativeSessions.clear();
  nativeSessions.set(session.id, session);
  realFs.writeFileSync(session.path, "{}", "utf8");
  const context = fakeContext([
    ownershipResult(session.id, LEAD_SESSION_ID, {
      path: session.path,
      definition: "reviewer",
      label: "review-fix",
    }),
  ]) as any;
  context.cwd = homedir();
  const byPath = await resolveAssignmentSession(context, session.path);
  assert.deepEqual(byPath, {
    path: session.path,
    id: session.id,
    definition: "reviewer",
    label: "review-fix",
    cwd: session.cwd,
  });
  const byId = await resolveAssignmentSession(context, session.id);
  assert.deepEqual(byId, byPath);
  const byTilde = await resolveAssignmentSession(context, `~/${name}`);
  assert.deepEqual(byTilde, byPath);
  assert.deepEqual(resolveAssignmentSession(context, name), byPath);
  assert.throws(
    () => resolveAssignmentSession(context, "11111111"),
    /prefixes are not allowed/,
  );
  nativeSessions.set("duplicate", {
    ...session,
    path: join(testTmpRoot, "native-resume-2.jsonl"),
  });
  realFs.writeFileSync(
    join(testTmpRoot, "native-resume-2.jsonl"),
    "{}",
    "utf8",
  );
  assert.deepEqual(resolveAssignmentSession(context, session.id), byPath);
  const missing = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ab",
    path: join(testTmpRoot, `missing-identity-${randomUUID()}.jsonl`),
    cwd: homedir(),
    entries: [],
  };
  nativeSessions.clear();
  nativeSessions.set(missing.id, missing);
  realFs.writeFileSync(missing.path, "{}", "utf8");
  const missingContext = fakeContext([
    ownershipResult(missing.id, LEAD_SESSION_ID, {
      path: missing.path,
      definition: "reviewer",
      label: "review-fix",
    }),
  ]);
  assert.throws(
    () => resolveAssignmentSession(missingContext, missing.path),
    /Saved assignment session is unavailable/,
  );
  nativeSessions.clear();
  realFs.rmSync(missing.path, { force: true });
  realFs.rmSync(session.path, { force: true });
});

test("owned continuation requires a matching persisted child edge", () => {
  const id = randomUUID();
  const path = join(testTmpRoot, `owned-validation-${id}.jsonl`);
  const identity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: { sessionId: id, definition: "agent", label: "agent" },
  };
  const session = { id, path, cwd: testTmpRoot, entries: [identity] };
  nativeSessions.clear();
  nativeSessions.set(id, session);
  const proof = ownershipResult(id, LEAD_SESSION_ID, { path });
  const context = (entry: unknown) => fakeContext([entry]);
  try {
    realFs.writeFileSync(path, "{}", "utf8");
    assert.equal(resolveAssignmentSession(context(proof), id).id, id);
    assert.throws(
      () =>
        resolveAssignmentSession(
          context({
            type: "message",
            message: {
              role: "toolResult",
              toolName: "agent_delegate",
              details: {
                ok: true,
                owner_session_id: LEAD_SESSION_ID,
                session_id: id,
                session_path: path,
                agent: "agent",
                definition: "agent",
              },
            },
          }),
          id,
        ),
      /ownership tree/,
    );
    for (const details of [
      { ownerSessionId: randomUUID() },
      { piSessionId: randomUUID() },
      { piSessionFile: undefined },
      { status: "unknown" },
      { requestId: "" },
    ]) {
      assert.throws(
        () =>
          resolveAssignmentSession(
            context({ ...proof, details: { ...proof.details, ...details } }),
            id,
          ),
        /ownership tree/,
      );
    }
    // A recorded child whose session can no longer be opened as that identity —
    // its file is gone or it no longer holds the recorded definition and label —
    // is named as unavailable instead of silently reported as unknown.
    for (const details of [
      { piSessionFile: join(testTmpRoot, "absent.jsonl") },
      { agentDefinition: "other" },
      { agentLabel: "other" },
    ]) {
      assert.throws(
        () =>
          resolveAssignmentSession(
            context({ ...proof, details: { ...proof.details, ...details } }),
            id,
          ),
        /Saved assignment session is unavailable/,
      );
    }
    session.entries = [];
    assert.throws(
      () => resolveAssignmentSession(context(proof), id),
      /Saved assignment session is unavailable/,
    );
  } finally {
    nativeSessions.clear();
    realFs.rmSync(path, { force: true });
  }
});

test("context retirement rejects managed session continuation only when enabled", async () => {
  const sessionId = "018f2f2e-7b13-7abc-8def-0123456789ae";
  const session = {
    id: sessionId,
    path: join(homedir(), "retired-managed.jsonl"),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId, definition: "agent", label: "retired-agent" },
      },
      {
        type: "custom",
        customType: "pi-herdsman-agent-context-retired",
        data: { sessionId },
      },
    ],
  };
  nativeSessions.clear();
  nativeSessions.set(sessionId, session);
  realFs.writeFileSync(session.path, "{}", "utf8");
  const context = fakeContext([
    ownershipResult(sessionId, LEAD_SESSION_ID, {
      path: session.path,
      label: "retired-agent",
    }),
  ]);
  try {
    updateConfig("contextRetirement", true);
    assert.throws(
      () => resolveAssignmentSession(context, session.path),
      /retired after context pressure/,
    );
    updateConfig("contextRetirement", false);
    assert.deepEqual(resolveAssignmentSession(context, session.path), {
      path: session.path,
      id: sessionId,
      definition: "agent",
      label: "retired-agent",
      cwd: resolve("/tmp"),
    });
  } finally {
    updateConfig("contextRetirement", undefined);
    nativeSessions.clear();
    realFs.rmSync(session.path, { force: true });
  }
});



test("a continued assignment takes its own watcher instruction and inherits none", async () => {
  for (const item of [
    {
      label: "continued-guided",
      instruction: "Only wake me if the migration stalls.",
    },
    { label: "continued-plain", instruction: undefined },
  ] as const) {
    setLeadEnvironment();
    nativeSessions.clear();
    const mailbox = agentMailboxPath(WORKSPACE, item.label);
    resetAgentMailbox(mailbox);
    const sourceId = randomUUID();
    const source = {
      id: sourceId,
      path: join(tmpdir(), `session-${item.label}-${randomUUID()}.jsonl`),
      cwd: "/tmp",
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { sessionId: sourceId, definition: "agent", label: item.label },
        },
      ],
    };
    realFs.writeFileSync(source.path, "{}", "utf8");
    nativeSessions.set(source.id, source);
    const pi = fakePi({});
    registerExtension!(pi.pi as never);
    try {
      const result = await agentTool(pi, "continue").execute(
        "id",
        {
          session: source.path,
          task: "continue the migration",
          ...(item.instruction === undefined
            ? {}
            : { watcherGuidance: item.instruction }),
        },
        undefined,
        undefined,
        fakeContext([
          ownershipResult(sourceId, LEAD_SESSION_ID, {
            path: source.path,
            label: item.label,
          }),
        ]),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      // The continued assignment is a new one, so its window carries what this
      // call supplied and nothing when it supplied nothing.
      const recorded = (pi.entries as any[])
        .filter(
          (entry) =>
            entry.customType === "pi-herdsman-soft-window" &&
            entry.data.requestId === result.details.request_id,
        )
        .at(-1)?.data.watcherGuidance;
      assert.equal(recorded, item.instruction);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      nativeSessions.clear();
      resetAgentMailbox(mailbox);
      realFs.rmSync(source.path, { force: true });
    }
  }
});



/**
 * A retained worker this session launched through Radar. The daemon holds the
 * edge it bound and the child's own mailbox keeps the generation it
 * acknowledged, so a continue meets the decision production makes.
 */
const retainedRadarWorker = async (
  definition: string,
  options: {
    launchedModel?: string;
    storedFingerprint?: "missing";
    /** The child command the retained process was launched under. */
    launchCommand?: string;
    onRequest?: (text: string, request: RequestRecord) => void;
  } = {},
) => {
  const label = `${definition}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${definition}.md`);
  const sourceId = DEFAULT_PI_SESSION_ID;
  const sourcePath = join(testTmpRoot, `${definition}-${sourceId}.jsonl`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${definition}\nmodel: explicit/new\n---\nretained\n`,
  );
  realFs.writeFileSync(sourcePath, "{}", "utf8");
  nativeSessions.set(sourceId, {
    id: sourceId,
    path: sourcePath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: sourceId, definition, label },
      },
    ],
  });
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = managedState(label, undefined, {
    paneId: "startup-pane",
    tabId: "startup-tab",
    piSessionId: sourceId,
    piSessionFile: sourcePath,
  });
  const { agentLaunchFingerprint, resolveAgentLaunchInputs } = await import(
    "./agent-definitions.ts"
  );
  const entries: any[] = [
    ownershipResult(sourceId, LEAD_SESSION_ID, {
      path: sourcePath,
      label,
      definition,
    }),
  ];
  if (options.storedFingerprint !== "missing")
    entries.push({
      type: "custom",
      customType: "pi-herdsman-worker-launch",
      data: {
        runId: state.runId,
        label,
        fingerprint: agentLaunchFingerprint(
          resolveAgentLaunchInputs(
            {
              name: definition,
              path: definitionPath,
              frontmatter: {
                name: definition,
                model: options.launchedModel ?? "explicit/new",
              },
              body: "retained",
            },
            { cwd: "/tmp", launchCommand: options.launchCommand },
          ),
        ),
      },
    });
  // A real Lead registers its tools, so its active-tool baseline is the registered set.
  const pi: ReturnType<typeof fakePi> = fakePi({
    entries,
    allTools: () => pi.tools,
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.model = { provider: "controller-provider", id: "controller-model" };
  context.thinkingLevel = "high";
  await startRadarSession(pi, context);
  // A relaunch continues the same Pi session in a new process.
  radarDaemon.childSession = () => ({ id: sourceId, file: sourcePath });
  const launch = await radarDaemon.adoptRetainedChild({
    label,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    mailbox,
    pane: state.paneId,
    definition,
  });
  const completedRequestId = randomUUID();
  writeAgentState(mailbox, { ...readAgentState(mailbox)!, completedRequestId });
  entries.push({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: launch,
  });
  if (options.onRequest) {
    const onRequest = options.onRequest;
    radarDaemon.onChildRequest = (_spawn, request) =>
      onRequest(request.text, request);
  }
  return {
    label,
    definition,
    definitionPath,
    sourceId,
    sourcePath,
    mailbox,
    state,
    completedRequestId,
    pi,
    context,
  };
};

const releaseRetainedWorker = (fixture: {
  pi: ReturnType<typeof fakePi>;
  mailbox: string;
  definitionPath: string;
  sourcePath: string;
}) => {
  fixture.pi.events.get("session_shutdown")?.[0]();
  nativeSessions.clear();
  resetAgentMailbox(fixture.mailbox);
  realFs.rmSync(fixture.definitionPath, { force: true });
  realFs.rmSync(fixture.sourcePath, { force: true });
};

test("definition drift relaunches a retained worker on the same session", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(
    `drift-${randomUUID().slice(0, 8)}`,
    { launchedModel: "explicit/old" },
  );
  try {
    const result = await continueRetainedWorker(fixture);
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.relaunched, "definition_changed");
    assert.equal(result.details.agent, fixture.label);
    assert.equal(radarDaemon.spawns[0]!.closed, true, "the stale process is closed");
    const argv = spawnedArgvs(radarDaemon).at(-1)!;
    assert.equal(argv[argv.indexOf("--session") + 1], fixture.sourcePath);
    assert.equal(argv[argv.indexOf("--model") + 1], "explicit/new");
    const restarted = readAgentState(fixture.mailbox)!;
    assert.notEqual(restarted.runId, fixture.state.runId);
    assert.equal(restarted.piSessionId, fixture.sourceId);
  } finally {
    releaseRetainedWorker(fixture);
  }
});



test("a changed child command relaunches a retained worker on the same session", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const command = tempChildCommand("drift");
  // The recorded launch carried no command; the current environment does.
  process.env.PI_HERDSMAN_CHILD_COMMAND = command;
  const fixture = await retainedRadarWorker(
    `command-drift-${randomUUID().slice(0, 8)}`,
  );
  try {
    const result = await continueRetainedWorker(fixture);
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.relaunched, "definition_changed");
    const relaunched = radarDaemon.spawns.at(-1)!;
    assert.equal(relaunched.executable, command, "the relaunch runs the current command");
    assert.equal(
      relaunched.argv[relaunched.argv.indexOf("--session") + 1],
      fixture.sourcePath,
      "the new process continues the same Pi session",
    );
  } finally {
    releaseRetainedWorker(fixture);
    realFs.rmSync(command, { force: true });
    delete process.env.PI_HERDSMAN_CHILD_COMMAND;
  }
});

test("a matching child command reuses the retained worker", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const command = tempChildCommand("match");
  process.env.PI_HERDSMAN_CHILD_COMMAND = command;
  const fixture = await retainedRadarWorker(
    `command-match-${randomUUID().slice(0, 8)}`,
    { launchCommand: command },
  );
  const spawns = radarDaemon.spawns.length;
  try {
    const result = await continueRetainedWorker(fixture);
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.relaunched, undefined);
    assert.equal(readAgentState(fixture.mailbox)!.runId, fixture.state.runId);
    assert.equal(
      radarDaemon.spawns.length,
      spawns,
      "a matching command keeps the existing process",
    );
  } finally {
    releaseRetainedWorker(fixture);
    realFs.rmSync(command, { force: true });
    delete process.env.PI_HERDSMAN_CHILD_COMMAND;
  }
});

test("clearing the child command relaunches a retained worker", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const command = tempChildCommand("cleared");
  const fixture = await retainedRadarWorker(
    `command-cleared-${randomUUID().slice(0, 8)}`,
    { launchCommand: command },
  );
  try {
    const result = await continueRetainedWorker(fixture);
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.relaunched, "definition_changed");
  } finally {
    releaseRetainedWorker(fixture);
    realFs.rmSync(command, { force: true });
  }
});

test("a retained worker the daemon cannot place is refused, never relaunched or reused", async () => {
  // Each cause leaves the child's presence unproved: a pane the daemon no longer
  // reports, an observed process exit, and an unreadable observation. Presence does
  // not decide a relaunch, the process proof does, and the default verdict for a
  // child that was never closed is `verified`, which refuses.
  for (const cause of [
    { locationEvidence: "absent" },
    { exitObservation: "exited" },
    { observeUnavailable: true },
  ] as const) {
    setLeadEnvironment();
    nativeSessions.clear();
    const fixture = await retainedRadarWorker(
      `unplaced-${randomUUID().slice(0, 8)}`,
    );
    Object.assign(radarDaemon.options, cause);
    const spawns = radarDaemon.spawns.length;
    try {
      const result = await continueRetainedWorker(fixture);
      assert.equal(result.details.ok, false, JSON.stringify(result.details));
      assert.ok(
        ["agent_busy", "target_ambiguous"].includes(result.details.error.category),
        JSON.stringify(result.details),
      );
      assert.equal(radarDaemon.spawns.length, spawns, "nothing is launched over it");
      assert.notEqual(radarDaemon.spawns[0]!.closed, true, "nothing is closed");
      assert.ok(readAgentState(fixture.mailbox), "the record is preserved");
    } finally {
      releaseRetainedWorker(fixture);
    }
  }
});

test("continuation preserves an unretrieved result instead of overwriting it", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(
    `durable-${randomUUID().slice(0, 8)}`,
    { launchedModel: "explicit/old" },
  );
  writeResult(fixture.mailbox, {
    version: 5,
    runId: fixture.state.runId,
    requestId: fixture.completedRequestId,
    ownerSessionId: fixture.state.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: fixture.label,
    paneId: fixture.state.paneId,
    status: "completed",
    text: "unread terminal result",
    completedAt: Date.now(),
  });
  try {
    const result = await continueRetainedWorker(fixture);
    assert.equal(result.details.ok, false, JSON.stringify(result.details));
    assert.equal(
      readResult(fixture.mailbox, fixture.completedRequestId)?.text,
      "unread terminal result",
      "the unread result is never silently overwritten",
    );
    assert.equal(radarDaemon.closes.size, 0, "no close is dispatched over it");
  } finally {
    releaseRetainedWorker(fixture);
  }
});

test("the relaunch close holds the session reservation against a concurrent continue", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(
    `drift-concurrent-${randomUUID().slice(0, 8)}`,
    { launchedModel: "explicit/old" },
  );
  // The close is applied when it arrives and answered only once released.
  const close = radarDaemon.holdNextClose();
  try {
    const first = continueRetainedWorker(fixture);
    await close.arrived;
    const second = await continueRetainedWorker(fixture);
    // The close owns the reservation, so the second continue is refused by the
    // session activation claim rather than by the assignment lock.
    assert.equal(second.details.error.category, "agent_busy", JSON.stringify(second.details));
    assert.match(second.details.error.message, /already being activated/);
    close.release();
    const firstResult = await first;
    assert.equal(firstResult.details.ok, true, JSON.stringify(firstResult.details));
    assert.equal(firstResult.details.relaunched, "definition_changed");
  } finally {
    close.release();
    releaseRetainedWorker(fixture);
  }
});

test("assignment response overrides do not relaunch a healthy retained worker", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(
    `response-override-${randomUUID().slice(0, 8)}`,
    { launchCommand: testChildCommand },
  );
  const spawns = radarDaemon.spawns.length;
  try {
    const task = testBrief("Return a report without changing the worker role.", "common").replace(
      "response: role-defaults",
      "response: { schema: response-contract/v1, target: inline, format: markdown, requiredSections: [Outcome] }",
    );
    const result = await agentTool(fixture.pi, "continue").execute(
      "id",
      { session: fixture.sourcePath, task },
      undefined,
      undefined,
      fixture.context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.relaunched, undefined);
    assert.equal(readAgentState(fixture.mailbox)!.runId, fixture.state.runId);
    assert.equal(
      radarDaemon.spawns.length,
      spawns,
      "an assignment-level response override is not a launch change",
    );
  } finally {
    releaseRetainedWorker(fixture);
  }
});

test("a missing launch entry relaunches a retained worker instead of reusing it", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(`missing-launch-${randomUUID().slice(0, 8)}`, {
    storedFingerprint: "missing",
  });
  try {
    const result = await continueRetainedWorker(fixture);
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.relaunched, "definition_changed");
    assert.equal(radarDaemon.spawns[0]!.closed, true, "the unproven process is closed");
    const argv = spawnedArgvs(radarDaemon).at(-1)!;
    assert.equal(argv[argv.indexOf("--session") + 1], fixture.sourcePath);
    assert.notEqual(readAgentState(fixture.mailbox)!.runId, fixture.state.runId);
  } finally {
    releaseRetainedWorker(fixture);
  }
});

test("a relaunch proceeds only on a proved absent or mismatched process, and a refusal consumes nothing", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(`verdicts-${randomUUID().slice(0, 8)}`, {
    launchedModel: "explicit/old",
  });
  try {
    // A registered process that still runs, and one whose birth identity cannot
    // be read, each refuse; the mailbox they leave is the one the next attempt uses.
    for (const verification of ["verified", "unavailable"] as const) {
      radarDaemon.options.processVerdict = verification;
      const refused = await continueRetainedWorker(fixture);
      assert.equal(refused.details.ok, false, `${verification} must refuse`);
      assert.equal(refused.details.error.category, "target_ambiguous");
      assert.ok(readAgentState(fixture.mailbox), "the mailbox is kept");
      assert.equal(radarDaemon.spawns.length, 1, "nothing is launched");
    }
    radarDaemon.options.processVerdict = "mismatched";
    const relaunched = await continueRetainedWorker(fixture);
    assert.equal(relaunched.details.ok, true, JSON.stringify(relaunched.details));
    assert.equal(relaunched.details.relaunched, "definition_changed");
    assert.equal(radarDaemon.spawns.length, 2);
  } finally {
    releaseRetainedWorker(fixture);
  }
});

test("a close outcome decides retirement, never permission on its own", async () => {
  // An exited pane is a close outcome, not proof that the process is gone, so the
  // process verdict decides it. A refusal is no more authority than an exit: the
  // process verdict decides it too, so a live process refuses whatever it said.
  for (const { setting, verdict, relaunches } of [
    { setting: { closeOutcome: "already_exited" }, verdict: "verified", relaunches: false },
    { setting: { closeOutcome: "already_exited" }, verdict: "absent", relaunches: true },
    { setting: { refuseChildClose: true }, verdict: "verified", relaunches: false },
  ] as const) {
    setLeadEnvironment();
    nativeSessions.clear();
    const fixture = await retainedRadarWorker(
      `outcome-${randomUUID().slice(0, 8)}`,
      { launchedModel: "explicit/old" },
    );
    Object.assign(
      radarDaemon.options,
      { closeOutcome: "completed", refuseChildClose: false, processVerdict: undefined },
      setting,
      // The daemon answers for this child's own process: a verdict of absent is
      // expressed on the record that process belongs to, never as an override
      // that would also answer for whatever replaces it.
      { processVerdict: verdict === "verified" ? "verified" : undefined },
    );
    if (verdict === "absent")
      radarDaemon.exitProcess(
        radarDaemon.spawns.find(
          (spawn) => spawn.env.PI_HERDSMAN_MAILBOX === fixture.mailbox,
        )!,
      );
    try {
      const result = await continueRetainedWorker(fixture);
      if (relaunches) {
        assert.equal(result.details.ok, true, JSON.stringify(result.details));
        assert.equal(radarDaemon.spawns.length, 2, "the absent process is relaunched");
      } else {
        assert.equal(result.details.ok, false, JSON.stringify(result.details));
        assert.equal(result.details.error.category, "target_ambiguous");
        assert.equal(radarDaemon.spawns.length, 1, "nothing is launched");
        assert.ok(readAgentState(fixture.mailbox), "the mailbox is kept");
      }
    } finally {
      releaseRetainedWorker(fixture);
    }
  }
});

test("a retained worker whose pane is gone relaunches only on a proved absent process", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  // Launched under the current child command, so the only reason to relaunch is the pane.
  const fixture = await retainedRadarWorker(`vanished-${randomUUID().slice(0, 8)}`, {
    launchCommand: testChildCommand,
  });
  try {
    // No close was ever sent: the pane is gone, so presence cannot prove the process.
    radarDaemon.vanishPane(radarDaemon.spawns[0]!);
    radarDaemon.options.processVerdict = "verified";
    const refused = await continueRetainedWorker(fixture);
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(refused.details.error.category, "target_ambiguous");
    assert.ok(readAgentState(fixture.mailbox), "the mailbox is kept");
    assert.equal(radarDaemon.spawns.length, 1, "nothing is launched");
    radarDaemon.options.processVerdict = "absent";
    const relaunched = await continueRetainedWorker(fixture);
    assert.equal(relaunched.details.ok, true, JSON.stringify(relaunched.details));
    assert.equal(relaunched.details.relaunched, "process_lost");
    assert.equal(radarDaemon.spawns.length, 2, "the absent process is relaunched");
    assert.equal(radarDaemon.closes.size, 0, "no close is sent over a pane that is gone");
  } finally {
    releaseRetainedWorker(fixture);
  }
});

test("a stored close never relaunches a child that has an outstanding assignment", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(`assigned-${randomUUID().slice(0, 8)}`);
  try {
    // The first attempt closes the live pane and is refused by the verified process.
    radarDaemon.options.processVerdict = "verified";
    const refused = await continueRetainedWorker(fixture);
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(radarDaemon.spawns[0]!.closed, true, "the pane was closed");
    writeAgentState(fixture.mailbox, {
      ...readAgentState(fixture.mailbox)!,
      activeRequestId: randomUUID(),
    });
    radarDaemon.options.processVerdict = "absent";
    const again = await continueRetainedWorker(fixture);
    assert.equal(again.details.ok, false, JSON.stringify(again.details));
    // The absent verdict makes this child presence `lost` (a loss under an outstanding
    // assignment), so the continuation refuses it as busy rather than as unproved.
    assert.equal(again.details.error.category, "agent_busy");
    assert.equal(radarDaemon.spawns.length, 1, "nothing is launched");
    assert.ok(readAgentState(fixture.mailbox), "the mailbox is kept");
  } finally {
    releaseRetainedWorker(fixture);
  }
});

test("a refused close is not authority: an absent process relaunches and the refused pane stays as residue", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  // A changed definition makes a retained child a relaunch decision, so the close
  // comes first. The daemon refuses that close while the process is still proved
  // present, and the absence proof taken after the refusal is what lets the
  // relaunch proceed: the refusal is no authority in either direction, and the
  // pane it leaves open must not be silent.
  const fixture = await retainedRadarWorker(`refused-${randomUUID().slice(0, 8)}`, {
    launchedModel: "explicit/old",
  });
  const close = radarDaemon.holdNextClose();
  try {
    radarDaemon.options.refuseChildClose = true;
    radarDaemon.options.processVerdict = "verified";
    const relaunching = continueRetainedWorker(fixture);
    await close.arrived;
    // The process of the child this close was refused for is now proved absent on
    // its own grounds, which is what authorizes the relaunch; the override goes so
    // the replacement answers for itself.
    radarDaemon.options.processVerdict = undefined;
    radarDaemon.exitProcess(radarDaemon.spawns[0]!);
    close.release();
    const relaunched = await relaunching;
    assert.equal(relaunched.details.ok, true, JSON.stringify(relaunched.details));
    assert.equal(radarDaemon.spawns.length, 2, "the absent process is relaunched");
    assert.notEqual(radarDaemon.spawns[0]!.closed, true, "the refused pane is left as residue");
    assert.match(String(relaunched.details.residue), /Pane .* was left open/, "the relaunch result names the residue");
  } finally {
    close.release();
    radarDaemon.options.refuseChildClose = false;
    releaseRetainedWorker(fixture);
  }
});

/** The fields the loss notice test reads from a sent wake message. */
type LossNotice = { customType?: string; content: string };

test("an unproved child with an outstanding assignment names no action it would refuse", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(`unproved-${randomUUID().slice(0, 8)}`);
  try {
    // The pane is gone and the process is still verified: presence is unknown, not lost.
    radarDaemon.vanishPane(radarDaemon.spawns[0]!);
    radarDaemon.options.processVerdict = "verified";
    writeAgentState(fixture.mailbox, {
      ...readAgentState(fixture.mailbox)!,
      activeRequestId: randomUUID(),
    });
    const result = await continueRetainedWorker(fixture);
    assert.equal(result.details.ok, false, JSON.stringify(result.details));
    assert.equal(result.details.error.category, "agent_busy", JSON.stringify(result.details));
    assert.match(result.details.error.nextAction, /cannot be proved absent/);
    assert.doesNotMatch(result.details.error.nextAction, /close|continue/);
    assert.equal(radarDaemon.spawns.length, 1, "nothing is launched");
    assert.equal(radarDaemon.closes.size, 0, "no close is sent");
    assert.ok(readAgentState(fixture.mailbox), "the mailbox is kept");
  } finally {
    releaseRetainedWorker(fixture);
  }
});

test("a proved-gone child with an outstanding assignment publishes a loss and retires nothing", async (t) => {
  setLeadEnvironment();
  nativeSessions.clear();
  const fixture = await retainedRadarWorker(`lost-${randomUUID().slice(0, 8)}`);
  try {
    // A refused proof keeps the mailbox and stores the completed close this loss rests on.
    radarDaemon.options.processVerdict = "verified";
    const refused = await continueRetainedWorker(fixture);
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(radarDaemon.spawns[0]!.closed, true);
    // A new assignment is outstanding, and it clears the previous completed marker.
    writeAgentState(fixture.mailbox, {
      ...readAgentState(fixture.mailbox)!,
      activeRequestId: randomUUID(),
      completedRequestId: undefined,
    });
    radarDaemon.options.processVerdict = "absent";
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await fixture.pi.events.get("session_start")![0](undefined, fixture.context);
    for (let index = 0; index < 4; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    const notices = (fixture.pi.sent as LossNotice[]).filter(
      (message) => message.customType === "pi-herdsman-agent-lost",
    );
    assert.equal(notices.length, 1, "the loss is published to the operator");
    assert.match(notices[0]!.content, /proved absent/);
    assert.match(notices[0]!.content, /neither resumed nor retired/);
    assert.match(notices[0]!.content, /Use agent_close/, "the notice names the action that works");
    assert.ok(readAgentState(fixture.mailbox), "the mailbox is kept");
    assert.equal(radarDaemon.spawns.length, 1, "nothing is launched");
    assert.equal(radarDaemon.closes.size, 1, "no second close is sent");
  } finally {
    releaseRetainedWorker(fixture);
  }
});

/** A real executable for `PI_HERDSMAN_CHILD_COMMAND`, outside the repository. */
const tempChildCommand = (suffix: string): string => {
  const path = join(
    tmpdir(),
    `pi-herdsman-child-command-${suffix}-${randomUUID().slice(0, 8)}`,
  );
  realFs.writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  return path;
};

const continueRetainedWorker = (fixture: {
  pi: ReturnType<typeof fakePi>;
  context: any;
  sourcePath: string;
}) =>
  agentTool(fixture.pi, "continue").execute(
    "id",
    { session: fixture.sourcePath, task: "continue under the current command" },
    undefined,
    undefined,
    fixture.context,
  );



















test("validated role-specific brief context reaches worker requests", async () => {
  for (const profile of ["investigation", "research", "execution", "review"] as const) {
    setLeadEnvironment();
    nativeSessions.clear();
    const name = `brief-${profile}-${randomUUID().slice(0, 4)}`;
    const received: RequestRecord[] = [];
    const fixture = await retainedRadarWorker(name, {
      launchCommand: testChildCommand,
      onRequest: (_text, request) => {
        received.push(request);
      },
    });
    try {
      const task = testBrief("Use the profile-specific context.", profile);
      const brief = parseDelegationBrief(task);
      const result = await agentTool(fixture.pi, "continue").execute(
        "id",
        { session: fixture.sourcePath, task },
        undefined,
        undefined,
        fixture.context,
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      const request = received.at(-1);
      assert.ok(request, "the retained worker receives the accepted assignment");
      assert.equal(request.acceptedAssignment?.brief.profile, profile);

      let roleValues: readonly string[];
      switch (profile) {
        case "investigation":
          assert.ok(brief.investigation);
          roleValues = [
            ...brief.investigation.questions,
            ...brief.investigation.targetLocations,
          ];
          break;
        case "research":
          assert.ok(brief.research);
          roleValues = [
            ...brief.research.questions,
            ...brief.research.sourceConstraints,
          ];
          break;
        case "execution":
          assert.ok(brief.execution);
          roleValues = [
            brief.execution.affectedArea,
            ...brief.execution.validationExpectations,
          ];
          break;
        case "review":
          assert.ok(brief.review);
          roleValues = [brief.review.baseline, ...brief.review.criteria];
          break;
      }
      for (const value of roleValues)
        assert.ok(request.text.includes(value), `${profile} context missing: ${value}`);
    } finally {
      fixture.pi.events.get("session_shutdown")?.[0]();
      nativeSessions.clear();
      resetAgentMailbox(fixture.mailbox);
      realFs.rmSync(fixture.definitionPath, { force: true });
      realFs.rmSync(fixture.sourcePath, { force: true });
    }
  }
});





test("session continuation inherits the saved label without an override", async () => {
  const label = "resume-stable";
  const run = async () => {
    setLeadEnvironment();
    nativeSessions.clear();
    const sourceId = randomUUID();
    const source = {
      id: sourceId,
      path: join(tmpdir(), `session-delegate-${randomUUID()}.jsonl`),
      cwd: "/tmp",
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { sessionId: sourceId, definition: "agent", label },
        },
      ],
    };
    realFs.writeFileSync(source.path, "{}", "utf8");
    nativeSessions.set(source.id, source);
    const entries: any[] = [
      ownershipResult(source.id, LEAD_SESSION_ID, { path: source.path, label }),
    ];
    const pi = fakePi({ entries });
    const context = fakeContext(entries) as any;
    context.model = { provider: "continue-provider", id: "continue-model" };
    context.thinkingLevel = "high";
    registerExtension!(pi.pi as never);
    await startRadarSession(pi, context);
    try {
      const result = await agentTool(pi, "continue").execute(
        "id",
        { session: source.path, task: "continue with the saved label" },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(result.details.agent, label);
      assert.equal(readAgentState(agentMailboxPath(WORKSPACE, label))?.agentLabel, label);
      const start = spawnedArgvs(radarDaemon).at(-1)!;
      assert.equal(start.includes("--model"), false);
      assert.equal(start.includes("--thinking"), false);
      assert.equal(start.includes("--fork"), false);
      assert.equal(start[start.indexOf("--session") + 1], realFs.realpathSync(source.path));
      return result;
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      nativeSessions.clear();
      resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
      realFs.rmSync(source.path, { force: true });
    }
  };

  const first = await run();
  assert.equal(first.details.agent, label);
  const reused = await run();
  assert.equal(reused.details.agent, label);
});

test("session continuation keeps explicit definition execution overrides", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const definition = `continue-override-${randomUUID().slice(0, 8)}`;
  const label = `${definition}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${definition}.md`);
  const sourceId = randomUUID();
  const sourcePath = join(tmpdir(), `session-continue-override-${sourceId}.jsonl`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${definition}\nmodel: explicit/provider\nthinking: low\n---\ncontinue\n`,
  );
  realFs.writeFileSync(sourcePath, "{}", "utf8");
  nativeSessions.set(sourceId, {
    id: sourceId,
    path: sourcePath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: sourceId, definition, label },
      },
    ],
  });
  const entries: any[] = [
    ownershipResult(sourceId, LEAD_SESSION_ID, { path: sourcePath, label, definition }),
  ];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.model = { provider: "controller-provider", id: "controller-model" };
  context.thinkingLevel = "high";
  await startRadarSession(pi, context);
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      { session: sourcePath, task: "continue" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const start = spawnedArgvs(radarDaemon).at(-1)!;
    assert.equal(start[start.indexOf("--model") + 1], "explicit/provider");
    assert.equal(start[start.indexOf("--thinking") + 1], "low");
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sourcePath, { force: true });
  }
});

test("delegate schema accepts a brief string and rejects an empty task", () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const schema = pi.tools.find(
    (candidate) => candidate.name === "agent_delegate",
  )!.parameters;
  assert.equal(
    Value.Check(schema, {
      definition: "agent",
      task: DELEGATION_BRIEF_EXAMPLES.common,
    }),
    true,
  );
  assert.equal(Value.Check(schema, { definition: "agent", task: "" }), false);
  pi.events.get("session_shutdown")?.[0]();
});

test("public assignment normalizes invalid and unknown session sources", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const pi = fakePi({
    exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
  });
  registerExtension!(pi.pi as never);
  try {
    for (const [value, diagnostic] of [
      ["11111111", /prefixes are not allowed/],
      ["11111111-1111-4111-8111-111111111111", /ownership tree/],
    ] as const) {
      const result = await agentTool(pi, "continue").execute(
        "id",
        {
          task: "resolve the source",
          session: value,
        },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, false, JSON.stringify(result.details));
      assert.equal(result.details.error.category, "invalid_request");
      assert.equal(result.details.error.operation, "continue");
      assert.match(result.details.error.message, diagnostic);
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
  }
});

test("session assignment rejects the controller's active session", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const session = {
    id: LEAD_SESSION_ID,
    path: join(testTmpRoot, "lead.jsonl"),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: LEAD_SESSION_ID,
          definition: "agent",
          label: "agent",
        },
      },
    ],
  };
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const pi = fakePi({
    exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      { session: session.path, task: "same session" },
      undefined,
      undefined,
      fakeContext([
        ownershipResult(session.id, LEAD_SESSION_ID, { path: session.path }),
      ]),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.operation, "continue");
    assert.match(result.details.error.message, /currently active Pi session/);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    nativeSessions.clear();
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("public assignment preserves session source open failures", async () => {
  setLeadEnvironment();
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789af",
    path: join(homedir(), "assignment-open-failure.jsonl"),
    cwd: "/tmp",
    entries: [],
  };
  nativeSessions.set(session.id, session);
  realFs.writeFileSync(session.path, "{}", "utf8");
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext([
    ownershipResult(session.id, LEAD_SESSION_ID, { path: session.path }),
  ]);
  const openOperationError = new OperationError({
    category: "internal_failure",
    message: "session dependency failed",
    operation: "session-open-test",
    rollbackOccurred: false,
    retryAttempted: false,
  });
  support.sessionOpenError = openOperationError;
  try {
    const structured = await agentTool(pi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "continue the saved session",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(structured.details.error, openOperationError.detail);

    const internalError = new Error("permission denied while opening session");
    support.sessionOpenError = internalError;
    await assert.rejects(
      agentTool(pi, "continue").execute(
        "id",
        {
          session: session.path,
          task: "continue the saved session",
        },
        undefined,
        undefined,
        context,
      ),
      (error) => error === internalError,
    );
  } finally {
    support.sessionOpenError = undefined;
    nativeSessions.clear();
    realFs.rmSync(session.path, { force: true });
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("assignment session rejects unusable saved cwd headers without mutation", async () => {
  setLeadEnvironment();
  for (const [name, cwd] of [
    ["missing", undefined],
    ["empty", ""],
  ] as const) {
    const id = randomUUID();
    const label = `assignment-session-cwd-${name}-${id}`;
    const path = join(testTmpRoot, `${id}.jsonl`);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    assert.equal(realFs.existsSync(mailbox), false);
    nativeSessions.clear();
    realFs.writeFileSync(path, "{}", "utf8");
    nativeSessions.set(id, { id, path, cwd });
    const pi = fakePi({
      exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext([
      ownershipResult(id, LEAD_SESSION_ID, { path }),
    ]);
    const result = await agentTool(pi, "continue").execute(
      "id",
      {
        session: path,
        task: "continue the saved session",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.rollbackOccurred, false);
    assert.match(result.details.error.message, /no non-empty cwd/);
    assert.deepEqual(pi.calls, []);
    assert.equal(realFs.existsSync(mailbox), false);
    assert.deepEqual(pi.entries, []);
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(path, { force: true });
  }
  nativeSessions.clear();
});

test("managed historical sources require durable owner-side ancestry for continue", async () => {
  setLeadEnvironment();
  const parentId = randomUUID();
  const sourceId = randomUUID();
  const sourcePath = join(testTmpRoot, `owned-source-${sourceId}.jsonl`);
  const parentPath = join(testTmpRoot, `owner-${parentId}.jsonl`);
  realFs.writeFileSync(sourcePath, "{}", "utf8");
  realFs.writeFileSync(parentPath, "{}", "utf8");
  nativeSessions.clear();
  nativeSessions.set(parentId, {
    id: parentId,
    path: parentPath,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: parentId, definition: "agent", label: "parent" },
      },
      ownershipResult(sourceId, parentId, {
        path: sourcePath,
        label: "owned-source",
      }),
    ],
  });
  const sourceEntries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId: sourceId, definition: "agent", label: "owned-source" },
    },
    ownershipResult(parentId, sourceId, { path: parentPath, label: "parent" }),
  ];
  nativeSessions.set(sourceId, {
    id: sourceId,
    path: sourcePath,
    cwd: "/tmp",
    entries: sourceEntries,
  });
  const parentProof = ownershipResult(parentId, LEAD_SESSION_ID, {
    path: parentPath,
    label: "parent",
  });
  const pi = fakePi({ exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }) });
  registerExtension!(pi.pi as never);
  const request = async (selector: string, entries: unknown[]) =>
    agentTool(pi, "continue").execute(
      "id",
      { session: selector, task: "follow up" },
      undefined,
      undefined,
      fakeContext(entries),
    );
  try {
    for (const selector of [sourceId, sourcePath]) {
      const recipient = await request(selector, [
        ownershipResult(randomUUID()),
      ]);
      assert.equal(recipient.details.error.category, "invalid_request");
      assert.match(recipient.details.error.message, /ownership tree/);
      const broken = await request(selector, [
        {
          ...parentProof,
          details: {
            ...parentProof.details,
            ownerSessionId: randomUUID(),
          },
        },
      ]);
      assert.equal(broken.details.error.category, "invalid_request");
    }
    sourceEntries.pop();
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }

  try {
    for (const proof of [
      [parentProof],
      [
        ownershipResult(sourceId, LEAD_SESSION_ID, {
          path: sourcePath,
          label: "owned-source",
        }),
      ],
    ]) {
      if (proof[0] !== parentProof) nativeSessions.delete(parentId);
      {
        const owner = fakePi({});
        registerExtension!(owner.pi as never);
        try {
          const result = await agentTool(owner, "continue").execute(
            "id",
            { session: sourceId, task: "follow up" },
            undefined,
            undefined,
            fakeContext(proof),
          );
          assert.equal(result.details.ok, true, JSON.stringify(result.details));
        } finally {
          owner.events.get("session_shutdown")?.[0]();
          resetAgentMailbox(agentMailboxPath(WORKSPACE, "owned-source"));
        }
      }
    }
  } finally {
    nativeSessions.clear();
    realFs.rmSync(sourcePath, { force: true });
    realFs.rmSync(parentPath, { force: true });
  }
});

test("copied fork result history does not invalidate the original owner edge", async () => {
  setLeadEnvironment();
  const parentId = randomUUID();
  const childId = randomUUID();
  const forkId = randomUUID();
  const childPath = join(testTmpRoot, `fork-history-child-${childId}.jsonl`);
  const parentPath = join(testTmpRoot, `fork-history-parent-${parentId}.jsonl`);
  const parentEntries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId: parentId, definition: "agent", label: "parent" },
    },
    ownershipResult(childId, parentId, { path: childPath, label: "child" }),
  ];
  realFs.writeFileSync(childPath, "{}", "utf8");
  realFs.writeFileSync(parentPath, "{}", "utf8");
  nativeSessions.clear();
  nativeSessions.set(parentId, {
    id: parentId,
    path: parentPath,
    entries: parentEntries,
  });
  nativeSessions.set(forkId, {
    id: forkId,
    path: join(testTmpRoot, `fork-history-fork-${forkId}.jsonl`),
    entries: [...parentEntries],
  });
  nativeSessions.set(childId, {
    id: childId,
    path: childPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: childId, definition: "agent", label: "child" },
      },
    ],
  });
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      { session: childId, task: "follow up" },
      undefined,
      undefined,
      fakeContext([
        ownershipResult(parentId, LEAD_SESSION_ID, {
          path: parentPath,
          label: "parent",
        }),
      ]),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "child"));
    nativeSessions.clear();
    realFs.rmSync(childPath, { force: true });
    realFs.rmSync(parentPath, { force: true });
  }
});

test("session assignment fails closed on duplicate live representations", async () => {
  setLeadEnvironment();
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ae",
    path: join(testTmpRoot, "duplicate-live-session.jsonl"),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "018f2f2e-7b13-7abc-8def-0123456789ae",
          definition: "agent",
          label: "session-conflict-label",
        },
      },
    ],
  };
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const first = managedState(
    "duplicate-live-one",
    undefined,
    recoveryIdentity("duplicate-live-one"),
  );
  const second = {
    ...managedState(
      "duplicate-live-two",
      undefined,
      recoveryIdentity("duplicate-live-two"),
    ),
    piSessionId: session.id,
    piSessionFile: session.path,
  };
  first.piSessionId = session.id;
  first.piSessionFile = session.path;
  const mailboxes = [first, second].map((state) => {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    return mailbox;
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && (isAgentList(args) || isApiSnapshot(args)))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agents: [agentFromState(first), agentFromState(second)],
              snapshot: {
                agents: [agentFromState(first), agentFromState(second)],
                panes: [first, second].map((state) => ({
                  pane_id: state.paneId,
                  workspace_id: state.workspaceId,
                  cwd: state.cwd,
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: state.piSessionId,
                  },
                })),
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
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "continue the ambiguous session",
      },
      undefined,
      undefined,
      fakeContext([
        ownershipResult(session.id, LEAD_SESSION_ID, {
          path: session.path,
          label: "session-conflict-label",
        }),
      ]),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    realFs.rmSync(session.path, { force: true });
  }
});

test("registered agent validates duplicate agents and selectors before lifecycle use", async () => {
  setLeadEnvironment();
  const label = "duplicate-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, undefined, identity));
  const duplicate = fakePi({});
  registerExtension!(duplicate.pi as never);
  await duplicate.events.get("session_start")![0](undefined, fakeContext());
  const tool = duplicate.tools.find(
    (candidate) => candidate.name === "agent_delegate",
  )!;
  assert.equal(tool.name, "agent_delegate");
  assert.equal(
    duplicate.tools.some((candidate) => candidate.name === "subagent"),
    false,
  );
  assert.equal(duplicate.commandOptions.has("agents"), true);
  assert.equal(duplicate.commandOptions.has("subagents"), false);
  const context = fakeContext();
  const duplicateResult = await tool.execute(
    "id",
    {
      definition: "agent",
      label,
      task: testBrief("duplicate task", "common"),
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(duplicateResult.details.error.category, "agent_label_exists");
  assert.equal(
    duplicate.calls.some((args) => args.includes("--env")),
    false,
  );
  const missingAgentTask = await tool.execute(
    "id",
    { definition: "agent" },
    undefined,
    undefined,
    context,
  );
  assert.equal(missingAgentTask.details.error.category, "invalid_request");
  const continueTool = duplicate.tools.find(
    (candidate) => candidate.name === "agent_continue",
  )!;
  const substitutedResume = await continueTool.execute(
    "id",
    {
      session: "/tmp/missing-session.jsonl",
      task: testBrief("continue", "common"),
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(substitutedResume.details.error.category, "invalid_request");
  duplicate.events.get("session_shutdown")?.[0]();
});

test("registered delegate protects a live mailbox owned by another owner", async () => {
  setLeadEnvironment();
  const label = "reviewer";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = {
    ...managedState(label, undefined, defaultFixtureIdentity),
    ownerSessionId: "owner-a",
  };
  writeAgentState(mailbox, state);
  writeRequest(mailbox, { version: 5, runId: state.runId,
  requestId: REQUEST_ID,
  ownerSessionId: state.ownerSessionId,
  workspaceId: WORKSPACE,
  agentLabel: label,
  paneId: state.paneId,
  kind: "task",
  text: "preserve me",
  createdAt: Date.now(), });
  writeResult(mailbox, { version: 5, runId: state.runId,
  requestId: REQUEST_ID,
  ownerSessionId: state.ownerSessionId,
  workspaceId: WORKSPACE,
  agentLabel: label,
  paneId: state.paneId,
  status: "completed",
  text: "preserve this result",
  completedAt: Date.now(), });
  const before = readFileSync(`${mailbox}/state.json`, "utf8");
  const requestBefore = readFileSync(
    `${mailbox}/request-${REQUEST_ID}.json`,
    "utf8",
  );
  const resultBefore = readFileSync(
    `${mailbox}/result-${REQUEST_ID}.json`,
    "utf8",
  );
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const tool = agentTool(pi, "delegate");
  const result = await tool.execute(
    "id",
    { definition: "agent", label, task: "preserve me" },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.error.category, "agent_label_exists");
  assert.equal(
    pi.calls.some((args) => args.includes("--placement")),
    false,
  );
  assert.equal(readFileSync(`${mailbox}/state.json`, "utf8"), before);
  assert.equal(
    readFileSync(`${mailbox}/request-${REQUEST_ID}.json`, "utf8"),
    requestBefore,
  );
  assert.equal(
    readFileSync(`${mailbox}/result-${REQUEST_ID}.json`, "utf8"),
    resultBefore,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(agentMailboxPath(WORKSPACE, "agent-2"));
});

test("fresh assignments do not reset an unacknowledged stale mailbox", async () => {
  setLeadEnvironment();
  const automaticLabel = "agent";
  const automaticMailbox = agentMailboxPath(WORKSPACE, automaticLabel);
  const automaticState = managedState(automaticLabel);
  const automaticRequestId = randomUUID();
  writeAgentState(automaticMailbox, automaticState);
  writeRequest(automaticMailbox, { version: 5, runId: automaticState.runId,
  requestId: automaticRequestId,
  ownerSessionId: automaticState.ownerSessionId,
  workspaceId: automaticState.workspaceId,
  agentLabel: automaticState.agentLabel,
  paneId: automaticState.paneId,
  kind: "task",
  text: "preserve automatic handoff",
  createdAt: Date.now(), });
  const automaticPi = fakePi({});
  registerExtension!(automaticPi.pi as never);
  const automatic = await agentTool(automaticPi, "delegate").execute(
    "id",
    {
      definition: "agent",
      task: "use the next safe label",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(automatic.details.ok, true, JSON.stringify(automatic.details));
  assert.equal(automatic.details.agent, `${automaticLabel}-2`);
  assert.ok(readRequest(automaticMailbox, automaticRequestId));
  automaticPi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(agentMailboxPath(WORKSPACE, automaticLabel + "-2"));
});

test("request-only mailbox remnants reserve their labels", async () => {
  setLeadEnvironment();
  const explicitLabel = "request-only-explicit";
  const explicitMailbox = agentMailboxPath(WORKSPACE, explicitLabel);
  const explicitRequestId = randomUUID();
  writeRequest(explicitMailbox, { version: 5, runId: AGENT_ID,
  requestId: explicitRequestId,
  ownerSessionId: LEAD_SESSION_ID,
  workspaceId: WORKSPACE,
  agentLabel: explicitLabel,
  paneId: "request-only-pane",
  kind: "task",
  text: "retain this request-only remnant",
  createdAt: Date.now(), });
  resetAgentMailbox(explicitMailbox);

  setLeadEnvironment();
  const automaticLabel = "agent";
  const automaticMailbox = agentMailboxPath(WORKSPACE, automaticLabel);
  const automaticRequestId = randomUUID();
  writeRequest(automaticMailbox, { version: 5, runId: AGENT_ID,
  requestId: automaticRequestId,
  ownerSessionId: LEAD_SESSION_ID,
  workspaceId: WORKSPACE,
  agentLabel: automaticLabel,
  paneId: "request-only-pane",
  kind: "task",
  text: "retain this request-only remnant",
  createdAt: Date.now(), });
  const automaticPi = fakePi({});
  registerExtension!(automaticPi.pi as never);
  const automatic = await agentTool(automaticPi, "delegate").execute(
    "id",
    {
      definition: "agent",
      task: "choose the next safe label",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(automatic.details.ok, true, JSON.stringify(automatic.details));
  assert.equal(automatic.details.agent, `${automaticLabel}-2`);
  assert.ok(readRequest(automaticMailbox, automaticRequestId));
  automaticPi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(agentMailboxPath(WORKSPACE, `${automaticLabel}-2`));
  resetAgentMailbox(automaticMailbox);
});
// Under Radar the launch is verified before the brief is written, so an unacknowledged
// launch never hands a brief to an unproved child. The launch is then a retained
// reservation: nothing releases it, even when the daemon reports its pane gone and its
// exit observed, because that evidence is not proof the process ended, and the pinned
// contract has no sanctioned retirement for a spawn edge that never bound a child.
// See context/unacknowledged-launch-holds-no-brief.md.
test("an unacknowledged launch is a retained reservation that nothing releases", async () => {
  setLeadEnvironment();
  radarDaemon.reset();
  const label = "agent";
  radarDaemon.options.acknowledge = false;
  process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "500";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    const abandoned = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "unacknowledged" },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      abandoned.details.error.category,
      "pane_not_ready",
      JSON.stringify(abandoned.details),
    );
    assert.equal(readAgentState(agentMailboxPath(WORKSPACE, label))?.activeRequestId, undefined);
    assert.equal(
      realFs.existsSync(agentMailboxPath(WORKSPACE, label))
        ? realFs.readdirSync(agentMailboxPath(WORKSPACE, label)).filter((name) => name.startsWith("request-")).length
        : 0,
      0,
    );
    assert.equal(radarDaemon.spawns.length, 1);

    // The daemon now reports the pane gone and its exit observed. The reservation
    // must still hold: a second delegate is refused and no close or second spawn occurs.
    radarDaemon.options.locationEvidence = "absent";
    radarDaemon.options.exitObservation = "exited";
    radarDaemon.options.acknowledge = true;
    const retried = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "retry" },
      undefined,
      undefined,
      context,
    );
    assert.equal(retried.details.error.category, "agent_label_exists");
    assert.equal(radarDaemon.spawns.length, 1);
    assert.equal(radarDaemon.closes.size, 0, "nothing is closed or released");
  } finally {
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    radarDaemon.options.acknowledge = true;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
    radarDaemon.reset();
  }
});

test("acknowledgement state-write failures retain requests for durable retry", () => {
  const cases = [
    {
      name: "busy rejection",
      kind: "task" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      expected: {
        accepted: false,
        code: "busy" as const,
        message: "Agent already has an active assignment",
      },
    },
    {
      name: "idle rejection",
      kind: "steer" as const,
      isIdle: true,
      expected: {
        accepted: false,
        code: "idle" as const,
        message: "Agent is not accepting steering",
      },
    },
    {
      name: "successful steer delivery",
      kind: "steer" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      expected: { accepted: true },
    },
    {
      name: "failed steer delivery",
      kind: "steer" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      deliveryFailure: true,
      expected: { accepted: true },
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const label = `ack-retry-${index}`;
    const mailbox = setAgentEnvironment(label);
    const activeRequestId = scenario.activeRequestId;
    writeAgentState(mailbox, managedState(label, activeRequestId));
    const agent = fakePi();
    registerExtension!(agent.pi as never);
    const context = fakeAgentContext();
    (context as any).isIdle = () => scenario.isIdle;
    agent.events.get("session_start")![0](undefined, context);
    if (scenario.deliveryFailure)
      agent.pi.sendUserMessage = () => {
        throw new Error("injected steer delivery failure");
      };

    const started = readAgentState(mailbox)!;
    const request: RequestRecord = { version: 5, runId: started.runId,
    requestId: randomUUID(),
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: scenario.kind,
    text: scenario.name,
    createdAt: Date.now(), };
    writeRequest(mailbox, request);
    support.failNextMailboxWrite = true;
    const input = agent.events.get("input")![0];
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      { action: "handled" },
    );
    assert.equal(readAgentState(mailbox)?.lastAck, undefined);
    assert.ok(readRequest(mailbox, request.requestId));
    assert.equal(agent.sentUsers.length, 0);

    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      scenario.expected.accepted
        ? { action: "transform", text: request.text }
        : { action: "handled" },
    );
    const acknowledged = readAgentState(mailbox)?.lastAck;
    assert.equal(acknowledged?.requestId, request.requestId, scenario.name);
    assert.equal(acknowledged?.accepted, scenario.expected.accepted);
    assert.equal(acknowledged?.code, scenario.expected.code);
    assert.equal(acknowledged?.message, scenario.expected.message);
    if (scenario.expected.accepted)
      assert.ok(readRequest(mailbox, request.requestId));
    else assert.equal(readRequest(mailbox, request.requestId), undefined);
    assert.equal(agent.sentUsers.length, 0);
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("assignment status normalization fails closed safely", async () => {
  setLeadEnvironment();
  const client = createRadarClient({ env: process.env });
  const cases = [
    { suffix: "working", activity: "working", expected: "WORKING" },
    { suffix: "blocked", activity: "blocked", expected: "BLOCKED" },
    { suffix: "idle", activity: "idle", expected: "IDLE/DONE" },
    { suffix: "done", activity: "done", expected: "IDLE/DONE" },
    { suffix: "unsupported", activity: "interactive", expected: "UNKNOWN" },
    {
      suffix: "stale",
      activity: "working",
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      expected: "UNKNOWN",
    },
    { suffix: "missing", expected: "UNKNOWN" },
  ];
  for (const [index, scenario] of cases.entries()) {
    const sessionId = randomUUID();
    const agentId = await registerStandaloneRadarAgent(
      sessionId,
      `tmux:herdsman-fixture:%${index + 2}`,
      scenario.activity === undefined
        ? undefined
        : {
            value: scenario.activity,
            ...(scenario.observedAt !== undefined
              ? { observedAt: scenario.observedAt }
              : {}),
          },
    );
    const read = await client.agentGet(agentId);
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error(read.message);
    const activity = read.value.activity;
    const runtimeState = activity === "idle" || activity === "working" ||
      activity === "blocked" || activity === "done"
      ? activity
      : "unknown";
    const group = classifySupervisedLead({
      lead: sessionId,
      displayName: scenario.suffix,
      runtimeState,
    });
    assert.equal(group, scenario.expected, `${scenario.suffix} publication fails closed`);
  }
});

test("agent list schema rejects unknown fields", () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const schema = agentTool(pi, "list").parameters;
  assert.equal(Value.Check(schema, {}), true);
  assert.equal(Value.Check(schema, { unknown: true }), false);
  pi.events.get("session_shutdown")?.[0]();
});

test("accepted assignments arm exactly one durable soft window", async () => {
  setLeadEnvironment();
  const label = "soft-window-agent";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "long assignment" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const windows = pi.entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-soft-window",
    );
    assert.equal(windows.length, 1, "one window entry per accepted assignment");
    const window = windows[0] as any;
    assert.equal(window.type, "custom");
    assert.equal(window.data.requestId, result.details.request_id);
    assert.equal(window.data.label, label);
    assert.equal(window.data.windowMs, 300_000);
    const ack = readAgentState(agentMailboxPath(WORKSPACE, label))!.lastAck!;
    assert.equal(ack.requestId, result.details.request_id);
    assert.equal(typeof window.data.armedAt, "number");
    assert.ok(
      window.data.armedAt >= ack.acknowledgedAt &&
        window.data.armedAt - ack.acknowledgedAt < 1_000,
      "the window is armed at observed acceptance",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
  }
});

test("agent_extend defers one worker's next digest and later windows revert", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const label = "soft-extend-agent";
  const pi = fakePi({ persistMessages: true });
  // The scan trigger below is this same lead session starting again, so it runs
  // with the session that owns the child, not a fresh one.
  const context = fakeContext(pi.entries);
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const digests = () =>
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-soft-deadline",
    );
  const windowEntries = () =>
    pi.entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-soft-window",
    );
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "long assignment" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await pi.events.get("session_start")![0](undefined, context);
    // Each timer step below is followed by the same barrier: every observe the
    // step started has finished, so a digest that is not due is absent for its
    // own reason and not because a scan is still running.
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(digests().length, 0, "a fresh window is not due");

    const extend = pi.tools.find(
      (candidate: any) => candidate.name === "agent_extend",
    )!;
    const extended = await extend.execute(
      "id",
      { agent: label, windowMs: 900_000 },
      undefined,
      undefined,
      context,
    );
    assert.equal(extended.details.ok, true, JSON.stringify(extended.details));
    assert.equal(extended.details.window_ms, 900_000);
    assert.equal(extended.details.request_id, result.details.request_id);
    assert.equal(extended.details.extended_at, now);

    now += 600_000;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      digests().length,
      0,
      "the default window elapsed but the extension defers the digest",
    );

    now += 299_999;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(digests().length, 0, "the extended window has not elapsed");

    now += 1;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(digests().length, 1, "the extended window delivers one digest");
    assert.equal(
      (digests()[0] as any).details.entries[0].windowMs,
      900_000,
      "the digest reports the extended window",
    );

    now += 300_000;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(digests().length, 2, "later windows revert to softTimeoutMs");
    assert.equal(
      (digests()[1] as any).details.entries[0].windowMs,
      300_000,
      "the automatic re-arm uses the configured length again",
    );
    assert.deepEqual(
      windowEntries()
        .filter((entry: any) => entry.data.extended === true)
        .map((entry: any) => entry.data.windowMs),
      [900_000],
      "the extension is recorded exactly once with its length",
    );
    assert.deepEqual(
      windowEntries().map((entry: any) => [
        entry.data.windowMs,
        entry.data.armedAt ?? entry.data.nextArmedAt,
      ]),
      [
        [300_000, now - 1_200_000],
        [900_000, now - 1_200_000],
        [300_000, now - 300_000],
        [300_000, now],
      ],
      "arming, extension, and both re-arms are recorded in order",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
  }
});

test("agent_extend rejects extra fields and every windowless worker", async () => {
  setLeadEnvironment();
  const cases: Array<{
    label: string;
    state: (label: string, identity: ReturnType<typeof recoveryIdentity>) => ManagedAgentState;
    category: string;
  }> = [
    {
      label: "extend-other-owner",
      state: (label, identity) => ({
        ...managedState(label, REQUEST_ID, identity),
        ownerSessionId: PARENT_SESSION_ID,
        lastAck: { requestId: REQUEST_ID, accepted: true, acknowledgedAt: Date.now() },
      }),
      category: "target_not_found",
    },
    {
      label: "extend-idle",
      state: (label, identity) =>
        managedState(label, undefined, identity),
      // Idle with no Radar observation: presence is unproven, so the refusal is ambiguity.
      category: "target_ambiguous",
    },
    {
      label: "extend-resolved",
      state: (label, identity) => ({
        ...managedState(label, undefined, identity),
        completedRequestId: REQUEST_ID,
      }),
      category: "target_ambiguous",
    },
  ];
  for (const value of cases) {
    const identity = recoveryIdentity(value.label);
    const mailbox = agentMailboxPath(WORKSPACE, value.label);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, value.state(value.label, identity));
    const pi = fakePi({});
    registerExtension!(pi.pi as never);
    try {
      const tool = pi.tools.find(
        (candidate: any) => candidate.name === "agent_extend",
      )!;
      assert.equal(
        Value.Check(tool.parameters, {
          agent: value.label,
          windowMs: 900_000,
        }),
        true,
        `${value.label} valid input`,
      );
      assert.equal(
        Value.Check(tool.parameters, {
          agent: value.label,
          windowMs: 900_000,
          task: "extra",
        }),
        false,
        `${value.label} rejects an extra field`,
      );
      const windowsBefore = pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-soft-window",
      ).length;
      const attempted = await tool.execute(
        "id",
        { agent: value.label, windowMs: 900_000 },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(attempted.details.ok, false, value.label);
      assert.equal(
        attempted.details.error.category,
        value.category,
        `${value.label}: ${JSON.stringify(attempted.details.error)}`,
      );
      assert.equal(
        pi.entries.filter(
          (entry: any) => entry.customType === "pi-herdsman-soft-window",
        ).length,
        windowsBefore,
        `${value.label} changed no window`,
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
});

test("softTimeoutMs of zero arms no window for an accepted assignment", async () => {
  setLeadEnvironment();
  updateConfig("softTimeoutMs", 0);
  const label = "soft-window-disabled";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "long assignment" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.ok(readAgentState(agentMailboxPath(WORKSPACE, label))?.activeRequestId);
    assert.deepEqual(
      pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-soft-window",
      ),
      [],
    );
  } finally {
    updateConfig("softTimeoutMs", undefined);
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
  }
});
