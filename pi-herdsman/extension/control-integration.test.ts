import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, test } from "node:test";
import {
  AGENT_ID,
  LEAD_SESSION_ID,
  PI_AGENT_ROOT,
  PI_AGENTS_DIR,
  WORKSPACE,
  agentMailboxPath,
  ensureRadarDaemon,
  fakeContext,
  fakePi,
  managedState,
  nativeSessions,
  radarDaemon,
  readAgentState,
  realFs,
  registerExtension,
  resetAgentMailbox,
  setLeadEnvironment,
  writeAgentState,
  writeResult,
} from "./support.ts";
import {
  controlClaimPath,
  controlDirectory,
  readControlResult,
  writeControlRequest,
  type ControlOperation,
  type ControlRequest,
} from "./control.ts";
import support from "./support.ts";

const { setConfigField } = await import("./support-config.ts");
// These suites drive retained workers; a test opts in per fixture.
beforeEach(() => setConfigField("retainWorkers", false));
// ---- Herdsman control (owner side) ----
//
// These tests drive the real owner path: a request file is written into the
// owner's control inbox and answered through the same close and relaunch paths
// `agent_close` uses, with the real `fs.watch` watching.

const leadControlDirectory = (): string => controlDirectory(LEAD_SESSION_ID);

const controlRequest = (
  operation: ControlOperation,
  agent: string,
  runId: string,
  extra: Partial<ControlRequest> = {},
): ControlRequest => ({
  version: 1,
  requestId: randomUUID(),
  operation,
  agent,
  runId,
  confirmation: { operation, label: agent, runId },
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  requester: "agent-radar",
  ...extra,
});

const answered = async (t: any, requestId: string) => {
  await t.waitFor(
    () =>
      assert.ok(
        readControlResult(leadControlDirectory(), requestId),
        "the owner did not answer the control request",
      ),
    { timeout: 5_000 },
  );
  return readControlResult(leadControlDirectory(), requestId)!;
};

const claimPathFor = (requestId: string): string =>
  controlClaimPath(leadControlDirectory(), requestId);

const claimExists = (requestId: string): boolean =>
  !!realFs.statSync(claimPathFor(requestId), { throwIfNoEntry: false });

const agentTool = (pi: ReturnType<typeof fakePi>, operation: string) =>
  pi.tools.find((candidate) => candidate.name === `agent_${operation}`)!;

/**
 * One idle retained managed worker of the lead, launched through Radar: the
 * daemon holds the launch edge, and the child's own binding, mailbox state and
 * startup acknowledgment are the facts a control close proves it by (ADR 0013).
 */
const controlWorkerFixture = (suffix: string) => {
  setLeadEnvironment();
  setConfigField("retainWorkers", true);
  const name = `ctl-${suffix}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  realFs.writeFileSync(definitionPath, `---\nname: ${name}\n---\nctl body\n`);
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  const session = {
    id: randomUUID(),
    path: sessionPath,
    cwd: "/tmp",
    entries: [],
  };
  nativeSessions.set(session.id, session);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const entries: unknown[] = [];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  const identity = {
    paneId: "startup-pane",
    tabId: "startup-tab",
    piSessionId: session.id,
    piSessionFile: sessionPath,
  };
  const state = {
    ...managedState(label, undefined, identity),
    agentDefinition: name,
    completedRequestId: randomUUID(),
  };
  const list = async () => {
    const listed = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    return listed.details.agents.find((agent: any) => agent.agent === label);
  };
  const publish = (
    text: string,
    status: "completed" | "failed" = "completed",
  ) =>
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
          status,
          text,
        },
      },
    });
  return {
    label,
    name,
    session,
    sessionPath,
    mailbox,
    pi,
    context,
    entries,
    state,
    identity,
    list,
    /**
     * Starts the session, then leaves the worker retained and idle.
     *
     * Radar performs the launch: the daemon records the edge this session
     * closes against, the child's own binding and mailbox state, and the
     * startup acknowledgment the child wrote for this launch generation. The
     * state the test dictates carries that acknowledgment, because a close
     * checks the child's generation against the launch it was created for.
     */
    async open() {
      await ensureRadarDaemon();
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, context);
      // The child the daemon simulates is this worker's own session, so the
      // acknowledgment it writes names the session this state does.
      radarDaemon.childSession = () => ({ id: session.id, file: sessionPath });
      const launch = await radarDaemon.adoptRetainedChild({
        label,
        runId: state.runId,
        ownerSessionId: LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        mailbox,
        pane: identity.paneId,
        definition: name,
        cwd: "/tmp",
      });
      entries.push({
        type: "custom",
        customType: "pi-herdsman-radar-spawn",
        data: launch,
      });
      const child = readAgentState(mailbox);
      writeAgentState(mailbox, {
        ...state,
        ...(child?.startupAck ? { startupAck: child.startupAck } : {}),
      });
      publish("first assignment");
    },
    /** The worker takes an assignment that has not produced a result yet. */
    work(requestId: string) {
      // Taking an assignment is not a new launch: the acknowledgment the child
      // wrote for this generation stays what a close proves it by.
      const current = readAgentState(mailbox);
      const working = {
        ...managedState(label, requestId, identity),
        agentDefinition: name,
        ...(current?.startupAck ? { startupAck: current.startupAck } : {}),
        updatedAt: Date.now(),
      };
      writeAgentState(mailbox, working);
      return working;
    },
    /** The worker's result is durably recorded but never retrieved. */
    leaveUnretrievedResult() {
      writeResult(mailbox, {
        version: 5,
        runId: state.runId,
        requestId: state.completedRequestId,
        ownerSessionId: LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: "startup-pane",
        status: "completed",
        text: "unretrieved",
        completedAt: Date.now(),
      });
    },
    /** The closes the daemon recorded: a Radar close issues no CLI command. */
    closes: () => [...radarDaemon.closes.values()],
    wakeMessages: () =>
      pi.sent.filter(
        (message: any) => message?.customType === "pi-herdsman-agent-result",
      ),
    controlEntries: () =>
      entries.filter((entry: any) => entry.customType === "pi-herdsman-control"),
    stopOwner() {
      for (const handler of pi.events.get("session_shutdown") ?? [])
        handler(undefined, context);
    },
    startOwner() {
      for (const handler of pi.events.get("session_start") ?? [])
        handler(undefined, context);
    },
    shutdown() {
      setConfigField("retainWorkers", undefined);
      this.stopOwner();
      nativeSessions.delete(session.id);
      resetAgentMailbox(mailbox);
      realFs.rmSync(definitionPath, { force: true });
      realFs.rmSync(sessionPath, { force: true });
      delete process.env.HERDR_PANE_ID;
    },
  };
};

test("a control request closes an idle retained worker and answers from its file", async (t) => {
  const worker = controlWorkerFixture("close");
  try {
    await worker.open();
    assert.equal((await worker.list())?.state, "idle");
    const usersBefore = worker.pi.sentUsers.length;
    const wakesBefore = worker.wakeMessages().length;
    const request = controlRequest("close", worker.label, AGENT_ID, {
      paneId: "startup-pane",
      piSessionId: worker.session.id,
      piSessionPath: worker.sessionPath,
    });
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "closed", JSON.stringify(result));
    assert.deepEqual(result.effects, ["process_ended", "pane_closed"]);
    assert.equal(result.category, undefined);
    assert.ok(
      claimExists(request.requestId),
      "the claim is the proof that execution started",
    );
    assert.equal(worker.closes().length, 1);
    assert.equal(readAgentState(worker.mailbox), undefined);
    assert.equal(await worker.list(), undefined);
    // The result file is the record: the wake hint that used to mirror it into
    // pane metadata is gone, and the control entry below is what the operator
    // reads.
    // An operator action is not a conversation turn.
    assert.equal(worker.wakeMessages().length, wakesBefore);
    assert.equal(worker.pi.sentUsers.length, usersBefore);
    assert.equal(worker.controlEntries().length, 1);
    assert.equal((worker.controlEntries()[0] as any).data.outcome, "closed");
  } finally {
    worker.shutdown();
  }
});

test("a control close abandons a working worker's assignment as closed by an operator", async (t) => {
  const worker = controlWorkerFixture("busy");
  try {
    await worker.open();
    worker.work(randomUUID());
    assert.equal((await worker.list())?.state, "working");
    const request = controlRequest("close", worker.label, AGENT_ID, {
      paneId: "startup-pane",
    });
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "closed", JSON.stringify(result));
    assert.ok(result.effects.includes("process_ended"));
    assert.equal(readAgentState(worker.mailbox), undefined);
    const wake = worker.wakeMessages() as any[];
    assert.equal(wake.length, 1, "the abandoned assignment must reach the model");
    assert.equal(wake[0].details.closedByOperator, true);
    assert.equal(wake[0].details.status, "failed");
    assert.equal(wake[0].details.agentLabel, worker.label);
    assert.match(String(wake[0].content), /Closed by an operator/);
  } finally {
    worker.shutdown();
  }
});

test("a control restart refuses a working target and leaves it untouched", async (t) => {
  // The replacement itself is the positive restart test above; this one owns the
  // owner-side refusal.
  const busy = controlWorkerFixture("restart-busy");
  try {
    await busy.open();
    const assignmentId = randomUUID();
    busy.work(assignmentId);
    assert.equal((await busy.list())?.state, "working");
    const request = controlRequest("restart", busy.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "refused");
    assert.equal(result.category, "agent_busy");
    assert.deepEqual(result.effects, []);
    assert.deepEqual(busy.closes(), []);
    assert.equal(readAgentState(busy.mailbox)?.activeRequestId, assignmentId);
    assert.deepEqual(busy.wakeMessages(), []);
  } finally {
    busy.shutdown();
  }
});

test("a control restart replaces an idle worker's process by close and relaunch", async (t) => {
  const worker = controlWorkerFixture("restart");
  try {
    await worker.open();
    const request = controlRequest("restart", worker.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "restarted", JSON.stringify(result));
    assert.ok(result.effects.includes("process_relaunched"));
    assert.equal(radarDaemon.spawns[0]!.closed, true, "the retained process is closed first");
    assert.equal(radarDaemon.spawns.length, 2, "a fresh launch replaces it");
    assert.notEqual(radarDaemon.spawns[1]!.pane, radarDaemon.spawns[0]!.pane, "in a new pane");
    assert.notEqual(readAgentState(worker.mailbox)?.runId, worker.state.runId, "as a new run");
  } finally {
    worker.shutdown();
  }
});

test("a control restart on an unreadable listing defers to the assignment state", async (t) => {
  // The positively non-idle side is the working-target refusal above. An unreadable
  // listing has no state to refuse on, so only the assignment state decides it.
  const worker = controlWorkerFixture("restart-unreadable");
  try {
    await worker.open();
    radarDaemon.vanishPane(radarDaemon.spawns[0]!);
    radarDaemon.options.processVerdict = "absent";
    assert.equal((await worker.list())?.state, "unknown");
    const assigned = controlRequest("restart", worker.label, AGENT_ID);
    writeAgentState(worker.mailbox, {
      ...readAgentState(worker.mailbox)!,
      activeRequestId: randomUUID(),
    });
    assert.equal(writeControlRequest(assigned, LEAD_SESSION_ID).ok, true);
    const refusedAssigned = await answered(t, assigned.requestId);
    assert.equal(refusedAssigned.outcome, "refused", JSON.stringify(refusedAssigned));
    assert.equal(radarDaemon.spawns.length, 1, "an outstanding assignment is not relaunched past");
    writeAgentState(worker.mailbox, {
      ...readAgentState(worker.mailbox)!,
      activeRequestId: undefined,
    });
    const request = controlRequest("restart", worker.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "restarted", JSON.stringify(result));
    assert.equal(radarDaemon.spawns.length, 2, "a fresh launch replaces it");
    assert.equal(radarDaemon.closes.size, 0, "no close is sent over a pane that is gone");
  } finally {
    worker.shutdown();
  }
});

test("a control close retires a proved-gone child's assignment without closing its pane", async (t) => {
  const gone = controlWorkerFixture("gone");
  try {
    await gone.open();
    gone.work(randomUUID());
    radarDaemon.vanishPane(radarDaemon.spawns[0]!);
    radarDaemon.options.processVerdict = "absent";
    const request = controlRequest("close", gone.label, AGENT_ID, {
      paneId: "startup-pane",
    });
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "closed", JSON.stringify(result));
    assert.match(result.message, /proved absent/, "the verdict is the recorded evidence");
    assert.equal(readAgentState(gone.mailbox), undefined, "the mailbox is retired");
    assert.equal(radarDaemon.closes.size, 0, "no pane close is sent");
    const wake = gone.wakeMessages() as any[];
    assert.equal(wake.length, 1, "the abandoned assignment reaches the model");
    assert.match(String(wake[0].content), /proved absent/);
  } finally {
    gone.shutdown();
  }
});

test("a control close refuses a child whose process is not proved gone and keeps its mailbox", async (t) => {
  const unproven = controlWorkerFixture("unproven");
  try {
    await unproven.open();
    unproven.work(randomUUID());
    radarDaemon.vanishPane(radarDaemon.spawns[0]!);
    radarDaemon.options.processVerdict = "verified";
    const request = controlRequest("close", unproven.label, AGENT_ID, {
      paneId: "startup-pane",
    });
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "refused", JSON.stringify(result));
    assert.equal(result.category, "target_not_found");
    assert.ok(readAgentState(unproven.mailbox), "the mailbox is kept");
    assert.equal(radarDaemon.closes.size, 0);
  } finally {
    unproven.shutdown();
  }
});

test("a control restart with a non-idle listing relaunches only on a proved-gone process", async (t) => {
  const settling = controlWorkerFixture("restart-gone");
  try {
    await settling.open();
    // A dead shell: the pane stays reported, so the listing reads the mailbox, and the
    // process is gone.
    radarDaemon.exitProcess(radarDaemon.spawns[0]!);
    writeAgentState(settling.mailbox, {
      ...readAgentState(settling.mailbox)!,
      completedRequestId: undefined,
    });
    assert.equal((await settling.list())?.state, "settling");
    const request = controlRequest("restart", settling.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "restarted", JSON.stringify(result));
    assert.equal(radarDaemon.spawns.length, 2, "the proved-gone process is replaced");
    assert.equal(radarDaemon.closes.size, 1, "the dead pane is closed before the absence proof");
  } finally {
    settling.shutdown();
  }
});

test("a control restart with a non-idle listing refuses while the process is not proved gone", async (t) => {
  const settling = controlWorkerFixture("restart-unproven");
  try {
    await settling.open();
    radarDaemon.options.processVerdict = "verified";
    writeAgentState(settling.mailbox, {
      ...readAgentState(settling.mailbox)!,
      completedRequestId: undefined,
    });
    assert.equal((await settling.list())?.state, "settling");
    const request = controlRequest("restart", settling.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "refused", JSON.stringify(result));
    assert.equal(result.category, "agent_busy");
    assert.equal(radarDaemon.spawns.length, 1, "nothing is relaunched");
    assert.ok(readAgentState(settling.mailbox), "the mailbox is kept");
  } finally {
    settling.shutdown();
  }
});

test("a control restart past a refused close names the residue it left", async (t) => {
  const worker = controlWorkerFixture("restart-residue");
  try {
    await worker.open();
    radarDaemon.options.refuseChildClose = true;
    radarDaemon.exitProcess(radarDaemon.spawns[0]!);
    const request = controlRequest("restart", worker.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "restarted", JSON.stringify(result));
    assert.match(result.message, /Pane .* was left open/, "the result names the residue");
    assert.equal(radarDaemon.spawns.length, 2, "the absent process is replaced");
  } finally {
    radarDaemon.options.refuseChildClose = false;
    worker.shutdown();
  }
});

test("control refusals name their category and leave the target as it was", async (t) => {
  const worker = controlWorkerFixture("refusal");
  try {
    await worker.open();
    const refused = async (request: ControlRequest) => {
      assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
      const result = await answered(t, request.requestId);
      assert.equal(result.outcome, "refused", JSON.stringify(result));
      assert.deepEqual(result.effects, []);
      return result;
    };

    // A supplied pane cross-check that disagrees refuses before any effect.
    const ambiguousPane = await refused(
      controlRequest("close", worker.label, AGENT_ID, { paneId: "other-pane" }),
    );
    assert.equal(ambiguousPane.category, "target_ambiguous");

    // The same guard covers the recorded Pi session, and it is re-checked at
    // execution time on the restart path the close-only checks never reached.
    const ambiguousSession = await refused(
      controlRequest("close", worker.label, AGENT_ID, {
        piSessionId: randomUUID(),
      }),
    );
    assert.equal(ambiguousSession.category, "target_ambiguous");
    const ambiguousRestart = await refused(
      controlRequest("restart", worker.label, AGENT_ID, {
        paneId: "other-pane",
      }),
    );
    assert.equal(ambiguousRestart.category, "target_ambiguous");
    assert.equal(worker.closes().length, 0);

    // No managed worker matches the named identity.
    const missing = await refused(
      controlRequest("close", "implementer-9", randomUUID()),
    );
    assert.equal(missing.category, "target_not_found");

    // A version this build does not speak is refused and leaves no claim.
    const versioned = controlRequest("close", worker.label, AGENT_ID, {
      version: 2,
    });
    assert.equal(writeControlRequest(versioned, LEAD_SESSION_ID).ok, true);
    const unsupportedVersion = await answered(t, versioned.requestId);
    assert.equal(unsupportedVersion.outcome, "refused");
    assert.equal(unsupportedVersion.category, "invalid_request");
    assert.equal(claimExists(versioned.requestId), false);

    // A confirmation that does not name this request's own target confirms
    // nothing, so it is refused before the claim too.
    const misconfirmed = controlRequest("close", worker.label, AGENT_ID, {
      confirmation: {
        operation: "close",
        label: `${worker.label}-other`,
        runId: AGENT_ID,
      },
    });
    assert.equal(writeControlRequest(misconfirmed, LEAD_SESSION_ID).ok, true);
    const badConfirmation = await answered(t, misconfirmed.requestId);
    assert.equal(badConfirmation.outcome, "refused");
    assert.equal(badConfirmation.category, "invalid_request");
    assert.equal(claimExists(misconfirmed.requestId), false);

    assert.ok(readAgentState(worker.mailbox), "the target is untouched");
    assert.equal((await worker.list())?.state, "idle");
  } finally {
    worker.shutdown();
  }
});

test("a generation replaced after the request is resolved is refused untouched", async (t) => {
  const worker = controlWorkerFixture("race");
  const replacement = {
    ...managedState(worker.label, undefined, {
      paneId: worker.identity.paneId,
      tabId: worker.identity.tabId,
      piSessionId: worker.session.id,
      piSessionFile: worker.sessionPath,
    }),
    // The replacement is a different generation of the same label: a new run.
    runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    agentDefinition: worker.name,
  };
  const statePath = join(worker.mailbox, "state.json");
  try {
    await worker.open();
    // The request resolves against generation A on the first read of the
    // mailbox; the second read is the one the shared close makes for the
    // generation it is about to act on, and the mailbox already holds the
    // generation that replaced it.
    let reads = 0;
    support.agentStateReadHook = (path) => {
      if (path !== statePath) return;
      reads += 1;
      if (reads < 2) return;
      support.agentStateReadHook = undefined;
      writeAgentState(worker.mailbox, replacement);
    };
    const request = controlRequest("close", worker.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "refused", JSON.stringify(result));
    assert.equal(result.category, "target_ambiguous");
    assert.deepEqual(result.effects, []);
    // The replacement is a different generation: it is not the target this
    // request resolved, so nothing may be done to it.
    assert.deepEqual(worker.closes(), []);
    assert.equal(readAgentState(worker.mailbox)?.runId, replacement.runId);
  } finally {
    support.agentStateReadHook = undefined;
    worker.shutdown();
  }
});

test("a request written while the owner was down is handled at start by expiry", async (t) => {
  const worker = controlWorkerFixture("expired");
  try {
    await worker.open();
    worker.stopOwner();
    const request = controlRequest("close", worker.label, AGENT_ID, {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    worker.startOwner();
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "refused");
    assert.equal(result.category, "invalid_request");
    assert.deepEqual(result.effects, []);
    assert.equal(
      claimExists(request.requestId),
      false,
      "an expired request is refused before the claim",
    );
    assert.deepEqual(worker.closes(), []);
    assert.ok(readAgentState(worker.mailbox), "the target is untouched");
  } finally {
    worker.shutdown();
  }
});

test("a control close is refused while the target's result is unretrieved", async (t) => {
  const worker = controlWorkerFixture("unretrieved");
  try {
    await worker.open();
    worker.leaveUnretrievedResult();
    assert.equal((await worker.list())?.state, "settling");
    const request = controlRequest("close", worker.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "refused", JSON.stringify(result));
    assert.deepEqual(result.effects, []);
    assert.deepEqual(worker.closes(), []);
    assert.ok(
      readAgentState(worker.mailbox),
      "the pane is left open and the target intact",
    );
  } finally {
    worker.shutdown();
  }
});
