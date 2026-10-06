import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import {
  AGENT_ID,
  LEAD_SESSION_ID,
  PI_AGENT_ROOT,
  PI_AGENTS_DIR,
  WORKSPACE,
  agentMailboxPath,
  fakeContext,
  fakePi,
  isPaneClose,
  isPreservePaneStop,
  managedState,
  nativeSessions,
  readAgentState,
  realFs,
  registerExtension,
  resetAgentMailbox,
  runScopedHerdrAlias,
  setLeadEnvironment,
  startupExecutor,
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

const { updateConfig } = await import("./config.ts");
// These suites drive retained workers; a test opts in per fixture.
beforeEach(() => updateConfig("retainWorkers", false));
const { agentLaunchFingerprint, resolveAgentLaunchInputs } =
  await import("./agent-definitions.ts");

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
 * One idle retained managed worker of the lead: its result was delivered and
 * its launch fingerprint is on record, so this session can close it or relaunch
 * it through the retained-worker path (ADR 0013).
 */
const controlWorkerFixture = (
  suffix: string,
  options: {
    snapshot?: (
      snapshot: any,
      details: { label: string; runId: string; sessionId: string },
    ) => void;
  } = {},
) => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  // The owner publishes its completion token on its own pane.
  process.env.HERDR_PANE_ID = "lead-pane";
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
  const starts: string[][] = [];
  const startup = startupExecutor(
    label,
    () => session.id,
    undefined,
    undefined,
    false,
    (args: string[]) => starts.push(args),
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    undefined,
    sessionPath,
  );
  // The fixture answers `agent get`, `pane get` and `api snapshot` with its own
  // default session identity, so every response is pinned to this worker's
  // session: the owner proves ownership against the recorded session.
  const pinSession = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) pinSession(item);
      return;
    }
    if (value.agent_session && typeof value.agent_session === "object")
      value.agent_session = {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: session.id,
      };
    for (const key of Object.keys(value)) pinSession(value[key]);
  };
  const exec = async (command: string, args: string[], execOptions: any) => {
    if (command === "herdr") {
      // `startupExecutor` writes a synthetic mailbox state for any command it
      // does not model, and the owner-state publication is one of them; these
      // three are answered here so the worker's record stays what the test
      // wrote and the relaunch can see a project topology.
      if (args[0] === "pane" && args[1] === "report-metadata")
        return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                repo_key: "repo-key",
                repo_name: "project",
                source_workspace_id: WORKSPACE,
              },
              worktrees: [],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "workspace" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              workspace: {
                worktree: { repo_key: "repo-key", is_linked_worktree: false },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
    }
    const result = await startup.exec(command, args, execOptions);
    if (command !== "herdr" || !["agent", "pane", "api"].includes(args[0]!))
      return result;
    let payload: any;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return result;
    }
    pinSession(payload);
    // A live agent answers with the run-scoped alias of the generation the
    // mailbox currently holds, so a state the test replaces mid-flight is the
    // generation Herdr reports, not the one this fixture started with.
    const current = readAgentState(mailbox);
    if (
      args[0] === "agent" &&
      args[1] === "get" &&
      current &&
      payload?.result?.agent
    )
      payload.result.agent.name = runScopedHerdrAlias(
        WORKSPACE,
        label,
        current.runId,
      );
    if (args[0] === "api" && options.snapshot)
      options.snapshot(payload.result.snapshot, {
        label,
        runId: AGENT_ID,
        sessionId: session.id,
      });
    return { ...result, stdout: JSON.stringify(payload) };
  };
  const entries: unknown[] = [];
  const pi = fakePi({ exec, entries });
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
    // The definition and the launch record are what this session needs to
    // close the worker or relaunch it.
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
    startup,
    pi,
    context,
    entries,
    state,
    identity,
    starts,
    list,
    /** Starts the session, then leaves the worker retained and idle. */
    async open() {
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, context);
      resetAgentMailbox(mailbox);
      writeAgentState(mailbox, state);
      publish("first assignment");
      entries.push({
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
                body: "ctl body",
              },
              { cwd: "/tmp" },
            ),
          ),
        },
      });
    },
    /** The worker takes an assignment that has not produced a result yet. */
    work(requestId: string) {
      const working = {
        ...managedState(label, requestId, identity),
        agentDefinition: name,
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
    metadata: () =>
      pi.calls.filter(
        (args) => args[0] === "pane" && args[1] === "report-metadata",
      ),
    paneCloses: () => pi.calls.filter((args) => isPaneClose(args)),
    preservedStops: () => pi.calls.filter((args) => isPreservePaneStop(args)),
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
      updateConfig("retainWorkers", undefined);
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
    assert.equal(worker.paneCloses().length, 1);
    assert.equal(readAgentState(worker.mailbox), undefined);
    assert.equal(await worker.list(), undefined);
    // The token is a hint on the owner's own pane; the result file is the record.
    await t.waitFor(
      () =>
        assert.ok(
          worker
            .metadata()
            .some((args) =>
              args.includes(`pi_herdsman_control=${request.requestId}:closed`),
            ),
          "the owner published no completion token",
        ),
      { timeout: 5_000 },
    );
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

test("a control restart relaunches an idle retained worker and refuses a busy one", async (t) => {
  const worker = controlWorkerFixture("restart");
  try {
    await worker.open();
    const request = controlRequest("restart", worker.label, AGENT_ID, {
      paneId: "startup-pane",
      piSessionId: worker.session.id,
    });
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "restarted", JSON.stringify(result));
    assert.deepEqual(result.effects, [
      "process_ended",
      "session_retained",
      "process_relaunched",
    ]);
    assert.equal(
      worker.preservedStops().length,
      1,
      "the retained process is stopped and its pane kept",
    );
    assert.deepEqual(worker.paneCloses(), []);
    const started = worker.starts.at(-1)!;
    assert.ok(started, "the worker was not relaunched");
    assert.equal(
      started[started.indexOf("--session") + 1],
      worker.sessionPath,
      "the relaunch continues the same Pi session",
    );
    assert.equal(
      started.includes("--session-dir"),
      false,
      "a restart keeps the saved session file where it is",
    );
  } finally {
    worker.shutdown();
  }

  // A working target is refused and left untouched.
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
    assert.deepEqual(busy.preservedStops(), []);
    assert.deepEqual(busy.paneCloses(), []);
    assert.equal(readAgentState(busy.mailbox)?.activeRequestId, assignmentId);
    assert.deepEqual(busy.wakeMessages(), []);
  } finally {
    busy.shutdown();
  }
});

test("control refusals name their category and leave the target as it was", async (t) => {
  const worker = controlWorkerFixture("refusal", {
    snapshot: (snapshot, details) => {
      // A live Pi identity with no owner pointer: a Lead or standalone session,
      // which has no owner to act on a request.
      snapshot.agents.push({
        name: "lead-session",
        agent_status: "idle",
        workspace_id: WORKSPACE,
        pane_id: "lead-pane",
        tab_id: "lead-tab",
        cwd: "/tmp",
        tokens: {
          pi_herdsman_label: "lead",
          pi_herdsman_run: "6c5b4a39-2817-4065-8e4d-3c2b1a09f876",
        },
      });
    },
  });
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
    assert.deepEqual(worker.preservedStops(), []);
    assert.equal(worker.paneCloses().length, 0);

    // No managed worker matches the named identity.
    const missing = await refused(
      controlRequest("close", "implementer-9", randomUUID()),
    );
    assert.equal(missing.category, "target_not_found");

    // A live identity with no owner pointer has nobody to ask.
    const unsupported = await refused(
      controlRequest(
        "restart",
        "lead",
        "6c5b4a39-2817-4065-8e4d-3c2b1a09f876",
      ),
    );
    assert.equal(unsupported.category, "unsupported_target");

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

test("a presence another pane can claim refuses without acting", async (t) => {
  const worker = controlWorkerFixture("ghost", {
    snapshot: (snapshot, details) => {
      // A second agent claims the same identity from another pane: presence
      // cannot be proved, so nothing may be done to this generation.
      snapshot.agents.push({
        name: runScopedHerdrAlias(WORKSPACE, details.label, details.runId),
        agent_status: "idle",
        workspace_id: WORKSPACE,
        pane_id: "ghost-pane",
        cwd: "/tmp",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "id",
          value: details.sessionId,
        },
      });
    },
  });
  try {
    await worker.open();
    const request = controlRequest("close", worker.label, AGENT_ID);
    assert.equal(writeControlRequest(request, LEAD_SESSION_ID).ok, true);
    const result = await answered(t, request.requestId);
    assert.equal(result.outcome, "refused", JSON.stringify(result));
    assert.equal(result.category, "target_not_found");
    assert.deepEqual(result.effects, []);
    assert.equal(worker.paneCloses().length, 0);
    assert.ok(readAgentState(worker.mailbox), "the target is untouched");
  } finally {
    worker.shutdown();
  }
});

test("a generation replaced after the request is resolved is refused untouched", async (t) => {
  // `resolved` turns true on the first inventory read after the request is
  // written; the swap lands on the next mailbox read, which is the one the
  // shared close makes for the generation it is about to act on.
  const gate = { armed: false, resolved: false };
  const worker = controlWorkerFixture("race", {
    snapshot: () => {
      if (gate.armed) gate.resolved = true;
    },
  });
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
    gate.armed = true;
    support.agentStateReadHook = (path) => {
      if (path !== statePath || !gate.resolved) return;
      support.agentStateReadHook = undefined;
      // The request was resolved against generation A; the mailbox already
      // holds the generation that replaced it.
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
    assert.deepEqual(worker.paneCloses(), []);
    assert.deepEqual(worker.preservedStops(), []);
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
    assert.deepEqual(worker.paneCloses(), []);
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
    assert.deepEqual(worker.paneCloses(), []);
    assert.ok(
      readAgentState(worker.mailbox),
      "the pane is left open and the target intact",
    );
  } finally {
    worker.shutdown();
  }
});
