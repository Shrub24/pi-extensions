import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  AGENT_ID,
  LEAD_SESSION_ID,
  WORKSPACE,
  agentMailboxPath,
  ensureRadarDaemon,
  fakeAgentContext,
  fakeContext,
  fakePi,
  managedState,
  nativeSessions,
  radarDaemon,
  radarObservedFleet,
  realFs,
  recoveryIdentity,
  registerExtension,
  resetAgentMailbox,
  setAgentEnvironment,
  setLeadEnvironment,
  writeAgentState,
} from "./support.ts";
import {
  leadCoordinationStatePath,
  supervisionRuntime,
  writeLeadCoordinationState,
} from "./supervision.ts";

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
    // Each worker records its own run: a shared run makes every worker a
    // candidate claimant of the others' pane, so none is provably live.
    const state = {
      ...managedState(label, randomUUID(), {
        ...recoveryIdentity(label),
        piSessionId: randomUUID(),
      }),
      runId: randomUUID(),
    };
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

test("a recurring tick never opens a legacy transcript, and an explicit listing still resolves the definition", async (t) => {
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
    setStatus: () => undefined,
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
  // Only the first read of the worker's transcript fails: that automatic
  // negative is what the runtime cache holds for the rest of the session.
  let failedFirstRead = false;
  manager.open = (...args: unknown[]) => {
    opens++;
    if (!failedFirstRead && args[0] === state.piSessionFile) {
      failedFirstRead = true;
      throw new Error("transcript unreadable");
    }
    return originalOpen(...args);
  };
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
  assert.ok(failedFirstRead, "the session start never read the transcript");
  const list = pi.tools.find((tool) => tool.name === "agent_list")!;
  const beforeExplicit = opens;
  const resolved = await list.execute("explicit-list", {}, undefined, undefined, context);
  assert.ok(opens > beforeExplicit, `explicit listing did not read the transcript: ${JSON.stringify(resolved)}`);
  assert.match(JSON.stringify(resolved), /probe-worker · definition worker/);
});

// Drives the recurring worker-leaf status tick. The leaf owns one mailbox whose
// owner is a lead Pi session; the lead boundary is proven from published
// coordination state (never the owner's transcript).
const startLeafStatusProbe = async (t: any, label: string) => {
  setAgentEnvironment(label);
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `${label}-${randomUUID()}.sock`,
  );
  const runtime = supervisionRuntime();
  const coordinatorPath = leadCoordinationStatePath(runtime, LEAD_SESSION_ID);
  t.after(() => {
    realFs.rmSync(coordinatorPath, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });

  // The leaf is a mailbox this session owns, so the daemon observes its row and
  // the snapshot lists it. Without the mailbox the leaf never reaches the lead walk.
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label));
  t.after(() => resetAgentMailbox(mailbox));
  // The owner lead is a daemon-observed agent whose session is its own UUID, in
  // this workspace: the canonical row the breadcrumb proves the lead from.
  await ensureRadarDaemon();
  radarDaemon.observeInventory = () => {
    const fleet = radarObservedFleet();
    const location = { workspace_id: WORKSPACE, tab_id: "lead-tab", pane_id: "lead-pane" };
    return {
      ...fleet,
      panes: [...fleet.panes, { location }],
      agents: [
        ...fleet.agents,
        { location, session: { kind: "uuid", value: LEAD_SESSION_ID } },
      ],
    };
  };
  const pi = fakePi({ activeTools: [] });

  const context = fakeAgentContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: any;
  context.ui = {
    setStatus: () => undefined,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = (content as any)(
          { requestRender: () => undefined },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        );
    },
    notify: () => undefined,
    select: async () => "tab",
  };

  const originalSetInterval = globalThis.setInterval;
  let leafTimer: TimerHandler | undefined;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    if (delay === 2000) leafTimer = callback;
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  t.after(async () => {
    globalThis.setInterval = originalSetInterval;
    await pi.events.get("session_shutdown")?.[0]();
  });

  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await settle(30);
  assert.ok(leafTimer, "leaf status timer registered");
  assert.ok(widget, "leaf status widget registered");
  const tick = async () => {
    (leafTimer as () => void)();
    await settle(30);
  };
  return { pi, context, runtime, coordinatorPath, widget, tick };
};

test("recurring leaf observation keeps malformed and absent coordinator state unknown", async (t) => {
  const { runtime, coordinatorPath, widget, tick } = await startLeafStatusProbe(
    t,
    "coordinator-probe",
  );

  // No coordinator record: the lead boundary stays unknown rather than proven.
  await tick();
  assert.match(widget.render(160)[0], /^● \? → agent:coordinator-probe/);
  assert.doesNotMatch(widget.render(160)[0], /unavailable/);

  // Malformed coordinator record: the read throws and the guard reports unknown.
  realFs.mkdirSync(dirname(coordinatorPath), { recursive: true });
  realFs.writeFileSync(coordinatorPath, "{ not json", "utf8");
  await tick();
  assert.match(widget.render(160)[0], /^● \? → agent:coordinator-probe/);
  assert.doesNotMatch(widget.render(160)[0], /unavailable/);

  // A valid record proves the lead boundary, so later ticks can grant authority.
  writeLeadCoordinationState(runtime, {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: LEAD_SESSION_ID,
    updatedAt: Date.now(),
  });
  await tick();
  assert.match(widget.render(160)[0], /^● herd → agent:coordinator-probe/);
});

test("recurring worker-leaf status ticks open no transcript body", async (t) => {
  const { runtime, widget, tick } = await startLeafStatusProbe(t, "leaf-open-probe");
  writeLeadCoordinationState(runtime, {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: LEAD_SESSION_ID,
    updatedAt: Date.now(),
  });

  // The lead is proven from coordination state and the daemon's row, not a transcript.
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

  const bootOpens = opens;
  await tick();
  const after1 = opens;
  await tick();
  const after2 = opens;

  assert.equal(
    after1 - bootOpens,
    0,
    "the recurring worker-leaf tick opened a transcript body",
  );
  assert.equal(
    after2 - after1,
    0,
    "the second recurring worker-leaf tick opened a transcript body",
  );
  assert.match(widget.render(160)[0], /^● herd → agent:leaf-open-probe/);
});
