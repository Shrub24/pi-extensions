import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  AGENT_ID,
  LEAD_SESSION_ID,
  WORKSPACE,
  agentMailboxPath,
  agentFromState,
  fakeContext,
  fakePi,
  managedState,
  nativeSessions,
  realFs,
  recoveryIdentity,
  registerExtension,
  resetAgentMailbox,
  setLeadEnvironment,
  writeAgentState,
} from "./support.ts";

const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

const softDigests = (pi: ReturnType<typeof fakePi>) =>
  pi.sent.filter(
    (message: any) =>
      message.customType === "pi-herdsman-agent-soft-deadline",
  );

test("a recurring health tick leaves a definition-less mailbox unresolved without opening a transcript body", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);

  // `legacy` carries a resolvable persisted definition and `opaque` carries
  // none: an ungated read opens the first and throws on the second.
  const workers = [
    { label: "health-tick-legacy", withDefinition: true },
    { label: "health-tick-opaque", withDefinition: false },
  ].map(({ label, withDefinition }) => {
    const state = managedState(label, randomUUID(), {
      ...recoveryIdentity(label),
      piSessionId: randomUUID(),
    });
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    nativeSessions.set(state.piSessionFile!, {
      id: state.piSessionId!,
      path: state.piSessionFile!,
      entries: withDefinition
        ? [
            {
              type: "custom",
              customType: "pi-herdsman-agent-definition",
              data: {
                sessionId: state.piSessionId,
                definition: "child",
                label,
              },
            },
          ]
        : [],
    });
    t.after(() => {
      resetAgentMailbox(mailbox);
      nativeSessions.delete(state.piSessionFile!);
    });
    return {
      label,
      state,
      listed: { ...agentFromState(state, "working"), agent: "pi", tokens: {} },
    };
  });

  const entries = workers.map(({ label, state }) => ({
    type: "custom",
    customType: "pi-herdsman-soft-window",
    data: {
      requestId: state.activeRequestId,
      label,
      runId: AGENT_ID,
      armedAt: now - 400_000,
      windowMs: 300_000,
    },
  }));
  const listed = workers.map((worker) => worker.listed);
  const envelope = JSON.stringify({
    id: AGENT_ID,
    result: {
      snapshot: { agents: listed, panes: listed },
      agents: listed,
      panes: listed,
    },
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr") {
        if (
          (args[0] === "api" && args[1] === "snapshot") ||
          (args[0] === "agent" && args[1] === "list")
        )
          return { stdout: envelope, stderr: "", code: 0 };
        if (args[0] === "agent" && args[1] === "get")
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                agent:
                  listed.find((candidate) => candidate.pane_id === args[2]) ??
                  listed[0],
              },
            }),
            stderr: "",
            code: 0,
          };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });

  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => ({
    unref: () => undefined,
  })) as unknown as typeof setInterval;
  t.after(async () => {
    globalThis.setInterval = originalSetInterval;
    await pi.events.get("session_shutdown")?.[0]();
  });

  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager as any;
  const originalOpen = manager.open;
  let opens = 0;
  manager.open = (...args: unknown[]) => {
    opens++;
    return originalOpen(...args);
  };
  t.after(() => {
    manager.open = originalOpen;
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settle(40);
  assert.equal(softDigests(pi).length, 1, "the overdue windows produced a digest");
  const bootOpens = opens;

  // Delivery re-arms both windows, so the next health tick finds them due again.
  now += 300_000;
  t.mock.timers.tick(30_000);
  await settle(40);

  assert.equal(
    opens - bootOpens,
    0,
    "the recurring health tick opened a transcript body",
  );
  const digests = softDigests(pi);
  assert.equal(digests.length, 2, "the next health tick delivered another digest");
  const ticked = (digests[1] as any).details.entries;
  assert.deepEqual(
    ticked.map((entry: any) => entry.agentLabel).sort(),
    workers.map((worker) => worker.label).sort(),
  );
  assert.equal(
    ticked.find((entry: any) => entry.agentLabel === "health-tick-opaque")
      .agentDefinition,
    "unknown",
  );
  // The legacy definition was resolved once by the session-start continuity
  // pass, so the tick reuses that value instead of re-reading the body.
  assert.equal(
    ticked.find((entry: any) => entry.agentLabel === "health-tick-legacy")
      .agentDefinition,
    "child",
  );
  assert.deepEqual(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ),
    [],
    "an unresolved definition must not infer lost attention",
  );
});

test("recurring lead status does not open transcript bodies, and explicit legacy resolution still wins", async (t) => {
  setLeadEnvironment();
  const leadFile = join(tmpdir(), `probe-lead-${randomUUID()}.jsonl`);
  realFs.writeFileSync(
    leadFile,
    JSON.stringify({ type: "session", id: LEAD_SESSION_ID, cwd: "/tmp" }) + "\n",
  );
  t.after(() => realFs.rmSync(leadFile, { force: true }));
  nativeSessions.set(leadFile, { id: LEAD_SESSION_ID, path: leadFile, entries: [] });

  const ownerMailbox = agentMailboxPath(WORKSPACE, "probe-worker");
  resetAgentMailbox(ownerMailbox);
  const state = managedState("probe-worker");
  writeAgentState(ownerMailbox, state);
  nativeSessions.set(state.piSessionFile!, {
    id: state.piSessionId!, path: state.piSessionFile!,
    entries: [{type: "custom", customType: "pi-herdsman-agent-definition",
      data: {sessionId: state.piSessionId, definition: "worker", label: "probe-worker"}}],
  });
  t.after(() => { resetAgentMailbox(ownerMailbox); nativeSessions.delete(state.piSessionFile!); nativeSessions.delete(leadFile); });

  const leadAgent = {
    agent: "pi",
    name: "probe-lead",
    agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: leadFile },
    agent_status: "working",
    cwd: "/tmp",
    pane_id: "probe-lead-pane",
    tab_id: "probe-lead-tab",
    workspace_id: WORKSPACE,
    tokens: { pi_herdsman_role: "lead" },
  };
  const workerAgent = { ...agentFromState(state), agent: "pi", tokens: {} };
  const envelope = JSON.stringify({
    id: AGENT_ID,
    result: {
      snapshot: { agents: [leadAgent, workerAgent], panes: [leadAgent, workerAgent] },
      agents: [leadAgent, workerAgent],
      panes: [leadAgent, workerAgent],
    },
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr") {
        if ((args[0] === "api" && args[1] === "snapshot") || (args[0] === "agent" && args[1] === "list"))
          return { stdout: envelope, stderr: "", code: 0 };
        if (args[0] === "agent" && args[1] === "get")
          return { stdout: JSON.stringify({ id: AGENT_ID, result: { agent: leadAgent } }), stderr: "", code: 0 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });

  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: any;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = (content as any)(
          { requestRender: () => undefined },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        );
    },
    notify: () => undefined,
    select: async () => undefined,
    confirm: async () => false,
    custom: async () => undefined,
  };

  const originalSetInterval = globalThis.setInterval;
  let statusTimer: TimerHandler | undefined;
  globalThis.setInterval = ((cb: TimerHandler, delay?: number) => {
    if (delay === 2000) statusTimer = cb;
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  t.after(async () => {
    globalThis.setInterval = originalSetInterval;
    await pi.events.get("session_shutdown")?.[0]();
  });

  const {SessionManager} = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager as any;
  const originalOpen = manager.open;
  let opens = 0;
  manager.open = (...args: unknown[]) => { opens++; return originalOpen(...args); };
  t.after(() => { manager.open = originalOpen; });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await settle();
  assert.ok(statusTimer, "lead status timer registered");
  const bootOpens = opens;

  const tick = async () => {
    (statusTimer as () => void)();
    await settle(25);
  };

  await tick();
  const after1 = opens;
  const rendered1 = widget ? widget.render(160).join("\n") : "";
  await tick();
  const after2 = opens;
  const rendered2 = widget ? widget.render(160).join("\n") : "";
  globalThis.setInterval = originalSetInterval;

  assert.equal(after1 - bootOpens, 0);
  assert.equal(after2 - after1, 0);
  assert.equal(rendered1, rendered2);
  assert.match(rendered1, /herd/);
  const list = pi.tools.find((tool) => tool.name === "agent_list")!;
  const beforeExplicit = opens;
  const resolved = await list.execute("explicit-list", {}, undefined, undefined, context);
  assert.ok(opens > beforeExplicit, `explicit legacy resolution did not open entries: ${JSON.stringify(resolved)}`);
  assert.match(JSON.stringify(resolved), /worker/);
});
