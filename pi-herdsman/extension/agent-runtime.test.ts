import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { beforeEach, mock, test } from "node:test";
import { Value } from "typebox/value";
import {
  DELEGATION_BRIEF_EXAMPLES,
  normalizeDelegationBrief,
  parseDelegationBrief,
} from "./briefs.ts";
import { DEFAULT_RESPONSE_CONTRACT } from "./response-contracts.ts";
import "./support.ts";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { claimProcessLock } from "./lock.ts";
import { registerBackgroundWorkProvider } from "../../pi-bash-processes/extensions/background-work.ts";
import support, {
  CHILD_SESSION_ID,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  controlMarker,
  fakeContext,
  fakePi,
  fakeAgentContext,
  managedState,
  assignmentLockPathForTest,
  readPendingAsk,
  readRequest,
  readResult,
  readAgentState,
  realFs,
  recoveryIdentity,
  removeAsk,
  registerExtension,
  removeRequest,
  removeResult,
  resetAgentMailbox,
  resultEntryDetails,
  sessionAgentIdentity,
  sessionContextRetired,
  setLeadEnvironment,
  setAgentEnvironment,
  watchedResultPaths,
  agentMailboxPath,
  writeAsk,
  writeRequest as writeMailboxRequest,
  writeResult,
  writeAgentState,
  testTmpRoot,
} from "./support.ts";
const {
  readQuestionWaitEvidence,
  RPIV_ASK_USER_BLOCKED_EVENT,
  writeQuestionWaitEvidence,
} = await import("./question-waiting.ts");
const { createAcceptedAssignmentContract } = await import(
  "./response-validation.ts"
);
const { writePrivatePromptSnapshots } = await import(
  "./agent-definitions.ts"
);
const { updateConfig, DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS } = await import(
  "./config.ts",
);
const { readCompletion, saveCompletion } = await import("./completions.ts");
function keepCompletion(owner: string, id: string): void {
  const completion = readCompletion(owner, id);
  assert.ok(completion, `completion ${id} exists`);
  completion.disposition = "keep";
  saveCompletion(completion);
}
// These suites cover the one-shot lifecycle; retained workers are the default,
// and the tests that exercise retention opt in or out explicitly.
beforeEach(() => updateConfig("retainWorkers", false));
function writeRequest(mailbox: string, request: RequestRecord): void {
  if (
    request.version === 5 &&
    (request.kind === "task" || request.kind === "interrupt")
  ) {
    if (!request.acceptedAssignment) {
      const state = readAgentState(mailbox);
      request = {
        ...request,
        acceptedAssignment: createAcceptedAssignmentContract(
          request.kind === "task"
            ? request.requestId
            : (state?.activeRequestId ??
              state?.completedRequestId ??
              request.requestId),
          parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
          DEFAULT_RESPONSE_CONTRACT,
          process.cwd(),
          1024 * 1024,
        ),
      };
    }
    request = {
      ...request,
      briefProfile:
        request.briefProfile ?? request.acceptedAssignment!.brief.profile,
    };
  }
  writeMailboxRequest(mailbox, request);
}
const agentTool = (pi: ReturnType<typeof fakePi>, name: string) =>
  pi.tools.find((candidate) => candidate.name === `agent_${name}`)!;

// Worker mode registers more than one session_shutdown listener; tests must
// run them all or a surviving request pump leaks into the next test.
function fireShutdown(agent: { events: Map<string, Array<(...args: never[]) => unknown>> }): void {
  for (const listener of agent.events.get("session_shutdown") ?? []) listener();
}

test("managed agents cancel native session replacement", () => {
  setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  assert.deepEqual(
    agent.events.get("session_before_switch")![0](undefined, fakeContext()),
    { cancel: true },
  );
  assert.deepEqual(
    agent.events.get("session_before_fork")![0](undefined, fakeContext()),
    { cancel: true },
  );
  fireShutdown(agent);
});

test("managed requests pump through Pi semantic input", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const mailbox = setAgentEnvironment("pump-agent");
  let context: ReturnType<typeof fakeAgentContext>;
  let transformed: unknown;
  let aborted = 0;
  const agent = fakePi({
    sendUserMessage(content) {
      transformed = agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "pump this task",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    t.mock.timers.tick(250);
    assert.deepEqual(transformed, { action: "transform", text: request.text });
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      request.requestId,
    );
    assert.equal(
      agent.calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
    assert.deepEqual(agent.sentUsers, [controlMarker(request.requestId)]);
    t.mock.timers.tick(250);
    assert.deepEqual(agent.sentUsers, [controlMarker(request.requestId)]);
    removeRequest(mailbox, request.requestId);
    (context as any).isIdle = () => false;
    const steer: RequestRecord = {
      ...request,
      requestId: randomUUID(),
      kind: "steer",
      text: "pump this steer",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, steer);
    t.mock.timers.tick(250);
    assert.equal(readAgentState(mailbox)?.lastAck?.requestId, steer.requestId);
    assert.deepEqual(transformed, {
      action: "transform",
      text: steer.text,
    });
    assert.deepEqual(agent.sentUserCalls, [
      {
        content: controlMarker(request.requestId),
        options: { deliverAs: "steer" },
      },
      {
        content: controlMarker(steer.requestId),
        options: { deliverAs: "steer" },
      },
    ]);
    context.isIdle = () => false;
    (context as any).abort = () => {
      aborted++;
    };
    const interrupt: RequestRecord = {
      ...steer,
      requestId: randomUUID(),
      kind: "interrupt",
      text: "pump this interrupt",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, interrupt);
    t.mock.timers.tick(250);
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      interrupt.requestId,
    );
    assert.equal(aborted, 1);
    assert.deepEqual(agent.sentUserCalls, [
      {
        content: controlMarker(request.requestId),
        options: { deliverAs: "steer" },
      },
      {
        content: controlMarker(steer.requestId),
        options: { deliverAs: "steer" },
      },
      {
        content: controlMarker(interrupt.requestId),
        options: { deliverAs: "steer" },
      },
    ]);
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("unfinished background work holds settlement through a flush and late work", { skip: "pending re-verification after Radar cutover, see session note #211" }, async () => {
  const mailbox = setAgentEnvironment("background-waiting-agent");
  const providerId = "test-background-provider";
  const agent = fakePi();
  let revision = 1;
  let outstanding: {
    taskId: string;
    state: string;
    reason: string;
    captureCertified?: boolean;
  }[] = [];
  let snapshotsUntilLateWork = 0;
  let protectedAssignment = false;
  let providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        if (snapshotsUntilLateWork > 0) {
          snapshotsUntilLateWork -= 1;
          if (snapshotsUntilLateWork === 0) {
            outstanding = [
              {
                taskId: "late-task",
                state: "running",
                reason: "task spawned during final response",
              },
            ];
            revision++;
          }
        }
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision,
          reconciliation: { state: "ready" },
          outstanding,
        };
      },
      bind() {
        return { ok: true };
      },
      protect(_scope: unknown, protect: boolean) {
        protectedAssignment = protect;
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      text: "retrieve and review the task result",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(request.requestId) },
        context,
      ),
      { action: "transform", text: request.text },
      JSON.stringify(readAgentState(mailbox)?.lastAck),
    );
    assert.deepEqual(readAgentState(mailbox)?.backgroundWorkProvider, {
      id: providerId,
      version: 1,
    });
    assert.equal(protectedAssignment, true);

    // A capture still flushing can change what the worker has; it must hold.
    outstanding = [
      {
        taskId: "flushing-task",
        state: "flushing",
        reason: "process ended; the capture is still settling",
      },
    ];
    revision++;
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "premature completion" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);

    const waiting = readAgentState(mailbox)!;
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.equal(waiting.activeRequestId, request.requestId);
    assert.equal(waiting.completedRequestId, undefined);
    assert.deepEqual(waiting.backgroundWaiting, {
      sessionId: context.sessionManager.getSessionId(),
      requestId: request.requestId,
      provider: { id: providerId, version: 1 },
      revision,
      taskIds: ["flushing-task"],
    });

    outstanding = [];
    revision++;
    assert.equal(
      providerRegistration.notifyChange({
        sessionId: context.sessionManager.getSessionId(),
        requestId: request.requestId,
      }),
      true,
    );
    // Nothing unfinished is left, so the marker carries no task ids and
    // projects no `waiting`; it persists only until a fresh answer settles.
    assert.deepEqual(readAgentState(mailbox)?.backgroundWaiting, {
      sessionId: context.sessionManager.getSessionId(),
      requestId: request.requestId,
      provider: { id: providerId, version: 1 },
      revision,
      taskIds: [],
    });
    assert.deepEqual(agent.sentUsers, []);

    // One snapshot carries both kinds of terminal entry: the certified but
    // unretrieved one is advisory, only the explicitly uncertified one holds.
    outstanding = [
      {
        taskId: "advisory-task",
        state: "awaiting-result-review",
        reason: "terminal capture ready; awaiting an actual result handoff",
      },
      {
        taskId: "incomplete-task",
        state: "awaiting-result-review",
        reason: "capture was never certified after restore",
        captureCertified: false,
      },
    ];
    revision++;
    agent.events.get("message_end")![0](
      {
        message: {
          role: "assistant",
          content: "continue waiting while output flushes",
        },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.deepEqual(readAgentState(mailbox)?.backgroundWaiting?.taskIds, [
      "incomplete-task",
    ]);

    // The already-delivered exit wake is not duplicated; the unresolved result
    // still keeps the assignment open for the owner to steer or the worker to resume.
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.deepEqual(agent.sentUsers, []);

    outstanding = [];
    revision++;
    snapshotsUntilLateWork = 2;
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "reviewed task result" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.deepEqual(readAgentState(mailbox)?.backgroundWaiting?.taskIds, [
      "late-task",
    ]);

    outstanding = [];
    revision++;
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "reviewed late task result" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(
      readResult(mailbox, request.requestId)?.text,
      "reviewed late task result",
    );
    const settled = readAgentState(mailbox)!;
    assert.equal(settled.activeRequestId, undefined);
    assert.equal(settled.backgroundWaiting, undefined);
    assert.equal(settled.backgroundWorkProvider, undefined);
    removeResult(mailbox, request.requestId);

    const driftRequest: RequestRecord = {
      version: 5,
      runId: settled.runId,
      requestId: randomUUID(),
      ownerSessionId: settled.ownerSessionId,
      workspaceId: settled.workspaceId,
      agentLabel: settled.agentLabel,
      paneId: settled.paneId,
      kind: "task",
      text: "verify provider identity before publication",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, driftRequest);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(driftRequest.requestId) },
        context,
      ),
      { action: "transform", text: driftRequest.text },
    );
    assert.equal(readAgentState(mailbox)?.backgroundWorkProvider?.version, 1);

    providerRegistration.dispose();
    providerRegistration = registerBackgroundWorkProvider(
      agent.pi.events as never,
      {
        id: providerId,
        version: 2,
        snapshot(scope: { sessionId: string; requestId: string }) {
          return {
            provider: { id: providerId, version: 2 },
            sessionId: scope.sessionId,
            requestId: scope.requestId,
            revision: 1,
            reconciliation: { state: "ready" },
            outstanding: [],
          };
        },
        bind() {
          return { ok: true };
        },
        protect() {
          return { ok: true };
        },
      },
    );
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "stale provider response" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    const blocked = readAgentState(mailbox)!;
    assert.equal(readResult(mailbox, driftRequest.requestId), undefined);
    assert.equal(blocked.activeRequestId, driftRequest.requestId);
    assert.equal(blocked.backgroundWaiting?.provider.version, 1);
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    resetAgentMailbox(mailbox);
  }
});

test("a recovered worker settles with an unretrieved prior-request result named in its answer", { skip: "pending re-verification after Radar cutover, see session note #211" }, async () => {
  const mailbox = setAgentEnvironment("carried-prior-result-agent");
  const providerId = "carried-prior-result-provider";
  const agent = fakePi();
  const revision = 1;
  // The production provider carries the finished, certified, unretrieved result
  // of an earlier request into the next assignment and retires it only on an
  // actual retrieval (ADR 0032 supersedes ADR 0023's blocking clause). A
  // recovered worker is a new process on the same session, so its new request
  // is bound while that task still awaits retrieval — and it settles anyway,
  // naming the unretrieved task in the answer it publishes.
  const outstanding = [
    {
      taskId: "bg-prior",
      state: "awaiting-result-review",
      reason: "a finished result of an earlier request awaits retrieval",
    },
  ];
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision,
          reconciliation: { state: "ready" },
          outstanding,
        };
      },
      bind() {
        return { ok: true };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      text: "continue the recovered work and retrieve the earlier result",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(request.requestId) },
        context,
      ),
      { action: "transform", text: request.text },
      JSON.stringify(readAgentState(mailbox)?.lastAck),
    );
    const bound = readAgentState(mailbox)!;
    assert.equal(bound.activeRequestId, request.requestId);
    assert.deepEqual(bound.backgroundWorkProvider, {
      id: providerId,
      version: 1,
    });

    // The new assignment answers. The certified-but-unretrieved result does not
    // hold it: the answer publishes, and it names the task it did not read.
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "recovered work done" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    const published = readResult(mailbox, request.requestId)!;
    assert.equal(published.status, "completed", JSON.stringify(published));
    assert.match(published.text ?? "", /recovered work done/u);
    assert.match(
      published.text ?? "",
      /Unreviewed background result bg-prior: a finished result of an earlier request awaits retrieval/u,
    );
    const settled = readAgentState(mailbox)!;
    assert.equal(settled.completedRequestId, request.requestId);
    assert.equal(settled.activeRequestId, undefined);
    // No hold evidence remains, so nothing projects `waiting` and no control is
    // restricted by background work.
    assert.equal(settled.backgroundWaiting, undefined);

    // Publication is exactly once: a further settlement cannot republish.
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.deepEqual(readResult(mailbox, request.requestId), published);
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    resetAgentMailbox(mailbox);
  }
});

test("only unfinished work holds while unreviewed terminal results settle", { skip: "pending re-verification after Radar cutover, see session note #211" }, async () => {
  const mailbox = setAgentEnvironment("mixed-advisory-agent");
  const providerId = "mixed-advisory-provider";
  const agent = fakePi();
  let revision = 1;
  // Both entries arrive in the same snapshot shape the provider publishes:
  // an unreviewed terminal result is advisory, a running process is not.
  let outstanding: { taskId: string; state: string; reason: string }[] = [
    {
      taskId: "live-task",
      state: "running",
      reason: "managed task spawned under this assignment is running",
    },
    {
      taskId: "advisory-task",
      state: "awaiting-result-review",
      reason: "terminal capture ready; awaiting an actual result handoff"
    },
  ];
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision,
          reconciliation: { state: "ready" },
          outstanding,
        };
      },
      bind() {
        return { ok: true };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      text: "answer once the running task finishes",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    agent.events.get("input")![0](
      { text: controlMarker(request.requestId) },
      context,
    );

    // The running task holds the assignment, and only it is evidenced: the
    // advisory terminal result must not extend the hold or the `waiting`
    // projection.
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "premature completion" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.deepEqual(readAgentState(mailbox)?.backgroundWaiting?.taskIds, [
      "live-task",
    ]);

    // The running task finishes; only the unreviewed terminal result remains.
    outstanding = outstanding.filter((task) => task.taskId === "advisory-task");
    revision++;
    agent.events.get("message_end")![0](
      {
        message: {
          role: "assistant",
          content: "the check finished and its output is above",
        },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);

    const published = readResult(mailbox, request.requestId)!;
    assert.equal(published.status, "completed", JSON.stringify(published));
    assert.match(published.text ?? "", /the check finished and its output is above/u);
    assert.match(
      published.text ?? "",
      /Unreviewed background result advisory-task: terminal capture ready; awaiting an actual result handoff/u,
    );
    const settled = readAgentState(mailbox)!;
    assert.equal(settled.activeRequestId, undefined);
    assert.equal(settled.completedRequestId, request.requestId);
    assert.equal(settled.backgroundWaiting, undefined);
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    resetAgentMailbox(mailbox);
  }
});

test("a recovered worker never adopts an earlier request's running or uncertified work", async () => {
  const mailbox = setAgentEnvironment("uncertified-prior-work-agent");
  const providerId = "uncertified-prior-work-provider";
  const agent = fakePi();
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision: 1,
          reconciliation: { state: "ready" },
          outstanding: [],
        };
      },
      // The production provider refuses a bind while unrelated work is live or
      // its capture was never certified; the refusal reason names the work.
      bind(scope: { requestId: string }) {
        return {
          ok: false,
          reason:
            `unresolved work not attributable to request "${scope.requestId}" ` +
            "blocks binding: bg-prior (running, or its capture is not certified); " +
            "reconcile it explicitly (bg_task get/stop/clear) before binding",
        };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      text: "continue after the earlier request left unread work",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(request.requestId) },
        context,
      ),
      { action: "handled" },
    );
    const refused = readAgentState(mailbox)!;
    assert.equal(refused.activeRequestId, undefined);
    assert.equal(refused.backgroundWorkProvider, undefined);
    assert.equal(refused.backgroundWaiting, undefined);
    assert.equal(refused.lastAck?.requestId, request.requestId);
    assert.equal(refused.lastAck?.accepted, false);
    assert.equal(refused.lastAck?.code, "busy");
    assert.match(
      refused.lastAck?.message ?? "",
      /unresolved work not attributable to request/u,
    );
    assert.equal(readRequest(mailbox, request.requestId), undefined);
    assert.equal(readResult(mailbox, request.requestId), undefined);
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    resetAgentMailbox(mailbox);
  }
});

test("settlement publishes an unread terminal result without a post-review response", { skip: "pending re-verification after Radar cutover, see session note #211" }, async () => {
  for (const listenerOrder of ["provider-first", "herdsman-first"] as const) {
    const mailbox = setAgentEnvironment(`post-review-${listenerOrder}`);
    const providerId = `post-review-provider-${listenerOrder}`;
    const agent = fakePi();
    const outstanding: { taskId: string; state: string; reason: string }[] = [
      {
        taskId: "review-result",
        state: "awaiting-result-review",
        reason: "terminal output still needs a successful read",
      },
    ];
    const resolveBackgroundWork = () => {};
    if (listenerOrder === "provider-first") {
      agent.pi.on("agent_settled", resolveBackgroundWork);
    }
    const providerRegistration = registerBackgroundWorkProvider(
      agent.pi.events as never,
      {
        id: providerId,
        version: 1,
        snapshot(scope: { sessionId: string; requestId: string }) {
          return {
            provider: { id: providerId, version: 1 },
            sessionId: scope.sessionId,
            requestId: scope.requestId,
            revision: 1,
            reconciliation: { state: "ready" },
            outstanding,
          };
        },
        bind() {
          return { ok: true };
        },
        protect() {
          return { ok: true };
        },
      },
    );
    registerExtension!(agent.pi as never);
    if (listenerOrder === "herdsman-first") {
      agent.pi.on("agent_settled", resolveBackgroundWork);
    }
    const context = fakeAgentContext();
    context.mode = "rpc";
    const settleListeners = async () => {
      for (const listener of agent.events.get("agent_settled") ?? []) {
        await listener(undefined, context);
      }
    };
    try {
      await agent.events.get("session_start")![0](undefined, context);
      const initial = readAgentState(mailbox)!;
      const request: RequestRecord = {
        version: 5,
        runId: initial.runId,
        requestId: randomUUID(),
        ownerSessionId: initial.ownerSessionId,
        workspaceId: initial.workspaceId,
        agentLabel: initial.agentLabel,
        paneId: initial.paneId,
        kind: "task",
        text: "review the completed task before answering",
        createdAt: Date.now(),
      };
      writeRequest(mailbox, request);
      assert.deepEqual(
        agent.events.get("input")![0](
          { text: controlMarker(request.requestId) },
          context,
        ),
        { action: "transform", text: request.text },
      );
      agent.events.get("message_end")![0](
        { message: { role: "assistant", content: "I will retry the failed result read." } },
        context,
      );
      await settleListeners();
      const published = readResult(mailbox, request.requestId)!;
      assert.equal(published.status, "completed");
      assert.match(published.text ?? "", /Unreviewed background result review-result/u);
      assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
      assert.equal(agent.sentUsers.length, 0);
      removeResult(mailbox, request.requestId);
    } finally {
      fireShutdown(agent);
      providerRegistration.dispose();
      resetAgentMailbox(mailbox);
    }
  }
});

test("a resolved recovery run that answers nothing fails the assignment, retrying its write", async (t) => {
  const mailbox = setAgentEnvironment("post-review-unanswered-agent");
  const providerId = "post-review-unanswered-provider";
  const agent = fakePi();
  let outstanding = [
    {
      taskId: "unfinished-task",
      state: "running",
      reason: "the spawned check is still running",
    },
  ];
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision: 1,
          reconciliation: { state: "ready" },
          outstanding,
        };
      },
      bind() {
        return { ok: true };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  const settleListeners = async () => {
    for (const listener of agent.events.get("agent_settled") ?? [])
      await listener(undefined, context);
  };
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      text: "review the completed task before answering",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(request.requestId) },
        context,
      ),
      { action: "transform", text: request.text },
    );

    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "I will retry the failed result read." } },
      context,
    );
    await settleListeners();
    assert.deepEqual(
      readAgentState(mailbox)?.backgroundWaiting?.taskIds,
      ["unfinished-task"],
    );

    // The provider resolves the work. The answer that preceded the wait is
    // discarded, and this request spends its one recovery prompt.
    outstanding = [];
    await settleListeners();
    await settleListeners();
    assert.equal(agent.sentUsers.length, 1);
    assert.match(
      String(agent.sentUsers[0]),
      /All background dependencies.*resolved/,
    );
    assert.equal(readResult(mailbox, request.requestId), undefined);

    // A settlement run before the prompted run turns is not evidence that the
    // worker failed to answer.
    await settleListeners();
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);

    // The prompted run turns and settles without producing an assistant message,
    // so nothing will ever answer the recovery prompt that was already spent.
    agent.events.get("turn_start")![0](undefined, context);

    // That failure's first write fails transiently, so the failed result has to
    // stay retryable instead of being abandoned with no timer left to retry it.
    const resultPath = join(mailbox, `result-${request.requestId}.json`);
    realFs.mkdirSync(resultPath);
    t.mock.timers.enable({ apis: ["setInterval"] });
    await settleListeners();
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);

    realFs.rmdirSync(resultPath);
    t.mock.timers.tick(250);
    await Promise.resolve();

    const published = readResult(mailbox, request.requestId);
    assert.equal(published?.status, "failed");
    assert.equal(published?.error?.code, "empty_result");
    assert.match(published?.error?.message ?? "", /no final response/u);
    assert.equal(published?.text, undefined);
    assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
    assert.equal(
      agent.sentUsers.length,
      1,
      "the recovery prompt stays bounded to one per request",
    );
    // The retry publishes once and stops.
    t.mock.timers.tick(250);
    await Promise.resolve();
    assert.deepEqual(readResult(mailbox, request.requestId), published);
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    resetAgentMailbox(mailbox);
  }
});

test("a withheld settlement retries without a provider wake", async (t) => {
  const mailbox = setAgentEnvironment("settlement-retry-agent");
  const providerId = "settlement-retry-provider";
  const state = managedState("settlement-retry-agent", REQUEST_ID);
  const provider = { id: providerId, version: 1 };
  state.backgroundWorkProvider = provider;
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  writeAgentState(mailbox, state);
  writeRequest(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "review the recovered background result",
    createdAt: Date.now(),
  });

  let revision = 1;
  let reconciliation:
    | { state: "ready" }
    | { state: "reconciling"; reason: string } = {
    state: "reconciling",
    reason: "the provider is still recovering terminal tasks",
  };
  let outstanding: { taskId: string; state: string; reason: string }[] = [
    { taskId: "pending-task", state: "running", reason: "still working" },
  ];
  const agent = fakePi();
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision,
          reconciliation,
          outstanding,
        };
      },
      bind() {
        return { ok: true };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    await agent.events.get("session_start")![0]({ reason: "reload" }, context);
    // The first settlement is withheld while the provider reconciles, and the
    // durable withhold record is written.
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    assert.deepEqual(readAgentState(mailbox)?.backgroundWaiting?.taskIds, [
      "pending-task",
    ]);
    assert.ok(
      agent.entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_state_error" &&
          String(entry.data?.error).includes(
            "background settlement withheld completion",
          ),
      ),
      "the durable withhold record is written",
    );

    // The provider becomes authoritative but still reports the task. The
    // backstop only re-queries: the worker stays held, no wake is manufactured.
    reconciliation = { state: "ready" };
    revision++;
    t.mock.timers.tick(5_000);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    assert.deepEqual(readAgentState(mailbox)?.backgroundWaiting?.taskIds, [
      "pending-task",
    ]);
    assert.equal(agent.sentUsers.length, 0);

    // The provider resolves atomically, with no change notification and no
    // provider wake, exactly the lost-wake case.
    outstanding = [];
    revision++;
    t.mock.timers.tick(5_000);
    assert.equal(
      agent.sentUsers.length,
      1,
      "the backstop requests a fresh final response",
    );

    agent.events.get("message_end")![0](
      {
        message: {
          role: "assistant",
          content: "The recovered background result is reviewed.",
        },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(
      readResult(mailbox, REQUEST_ID)?.text,
      "The recovered background result is reviewed.",
    );
    // Publication is exactly once: later retries find no active assignment.
    t.mock.timers.tick(30_000);
    assert.equal(
      readResult(mailbox, REQUEST_ID)?.text,
      "The recovered background result is reviewed.",
    );
    assert.equal(agent.sentUsers.length, 1);
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    removeRequest(mailbox, REQUEST_ID);
    removeResult(mailbox, REQUEST_ID);
    resetAgentMailbox(mailbox);
  }
});

test("a held worker that resumes with an artifact-only response publishes", async () => {
  const mailbox = setAgentEnvironment("artifact-waiting-agent");
  const providerId = "artifact-waiting-provider";
  const agent = fakePi();
  let revision = 1;
  let outstanding: { taskId: string; state: string; reason: string }[] = [
    {
      taskId: "artifact-task",
      state: "running",
      reason: "the artifact is not written yet",
    },
  ];
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision,
          reconciliation: { state: "ready" },
          outstanding,
        };
      },
      bind() {
        return { ok: true };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  const artifactPath = `held-artifact-${randomUUID()}.md`;
  let canonicalPath: string | undefined;
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    canonicalPath = join(initial.cwd, artifactPath);
    const requestId = randomUUID();
    const brief = normalizeDelegationBrief({
      ...parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
      response: {
        schema: "response-contract/v1",
        target: "artifact",
        format: "markdown",
        path: artifactPath,
        requiredSections: ["Outcome"],
      },
    });
    writeRequest(mailbox, {
      version: 5,
      runId: initial.runId,
      requestId,
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      acceptedAssignment: createAcceptedAssignmentContract(
        requestId,
        brief,
        DEFAULT_RESPONSE_CONTRACT,
        initial.cwd,
        1024 * 1024,
      ),
      text: "Write the report artifact and report back",
      createdAt: Date.now(),
    });
    agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
    agent.events.get("message_end")![0](
      {
        message: {
          role: "assistant",
          content: "waiting for the background task to finish",
        },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, requestId), undefined);
    assert.ok(
      readAgentState(mailbox)?.backgroundWaiting,
      "the worker is held while its background task runs",
    );

    // The task resolves and the wake resumes the worker. An artifact-target
    // contract does not require inline text, so this turn ends with an empty
    // assistant message and only the artifact as its answer.
    outstanding = [];
    revision++;
    writeFileSync(canonicalPath!, "## Outcome\nArtifact-backed response", "utf8");
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);

    const result = readResult(mailbox, requestId);
    assert.equal(result?.status, "completed", JSON.stringify(result));
    assert.equal(result?.text, `Artifact validated: ${artifactPath}`);
    assert.equal(
      readAgentState(mailbox)?.backgroundWaiting,
      undefined,
      "the held marker clears once the artifact response is published",
    );
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    if (canonicalPath) realFs.rmSync(canonicalPath, { force: true });
    resetAgentMailbox(mailbox);
  }
});

test("registered provider reconciliation errors fail closed at settlement", async () => {
  const mailbox = setAgentEnvironment("background-error-agent");
  const providerId = "test-background-provider-error";
  const agent = fakePi();
  let reconciliation: { state: "ready" } | { state: "error"; reason: string } =
    { state: "ready" };
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: providerId,
      version: 1,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider: { id: providerId, version: 1 },
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision: 1,
          reconciliation,
          outstanding: [
            {
              taskId: "provider-owned-task",
              state: "running",
              reason: "still running",
            },
          ],
        };
      },
      bind() {
        return { ok: true };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      text: "wait for provider recovery",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(request.requestId) },
        context,
      ),
      { action: "transform", text: request.text },
    );

    reconciliation = { state: "error", reason: "temporary provider failure" };
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "premature completion" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);

    const blocked = readAgentState(mailbox)!;
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.equal(blocked.activeRequestId, request.requestId);
    assert.equal(blocked.completedRequestId, undefined);
    assert.deepEqual(blocked.backgroundWaiting, {
      sessionId: context.sessionManager.getSessionId(),
      requestId: request.requestId,
      provider: { id: providerId, version: 1 },
      revision: 1,
      taskIds: ["provider-owned-task"],
    });
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    resetAgentMailbox(mailbox);
  }
});

test("a steer reaches a waiting worker without changing its assignment, while interrupt is refused", async () => {
  const mailbox = setAgentEnvironment("waiting-steer-agent");
  const initial = managedState("waiting-steer-agent", REQUEST_ID);
  const provider = { id: "waiting-steer-provider", version: 1 };
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.isIdle = () => true;
  writeAgentState(mailbox, {
    ...initial,
    backgroundWorkProvider: provider,
    backgroundWaiting: {
      sessionId: context.sessionManager.getSessionId(),
      requestId: REQUEST_ID,
      provider,
      revision: 1,
      taskIds: ["still-running"],
    },
  });
  try {
    agent.events.get("session_start")![0](undefined, context);
    const base: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "steer",
      text: "Retrieve or stop your background task.",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, base);
    assert.deepEqual(
      agent.events.get("input")![0]({ text: controlMarker(base.requestId) }, context),
      { action: "transform", text: base.text },
      "an idle waiting worker accepts the owner's cooperative steer",
    );
    const afterSteer = readAgentState(mailbox)!;
    assert.equal(afterSteer.activeRequestId, REQUEST_ID, "the same assignment continues");
    assert.deepEqual(afterSteer.backgroundWaiting?.taskIds, ["still-running"]);
    assert.equal(afterSteer.lastAck?.requestId, base.requestId);

    const interrupt: RequestRecord = {
      ...base,
      requestId: randomUUID(),
      kind: "interrupt",
      text: "Abort everything.",
    };
    writeRequest(mailbox, interrupt);
    assert.deepEqual(
      agent.events.get("input")![0]({ text: controlMarker(interrupt.requestId) }, context),
      { action: "handled" },
    );
    const afterInterrupt = readAgentState(mailbox)!;
    assert.equal(afterInterrupt.activeRequestId, REQUEST_ID);
    assert.deepEqual(afterInterrupt.backgroundWaiting?.taskIds, ["still-running"]);
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("a worker without a background provider completes through ordinary settlement", async () => {
  const mailbox = setAgentEnvironment("no-provider-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: randomUUID(),
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "plain assignment",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0]({ text: controlMarker(request.requestId) }, context);
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "finished" } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  await agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, request.requestId)?.status, "completed");
  const settled = readAgentState(mailbox)!;
  assert.equal(settled.backgroundWorkProvider, undefined);
  assert.equal(settled.backgroundWaiting, undefined);
  assert.equal(settled.completedRequestId, request.requestId);
  fireShutdown(agent);
  resetAgentMailbox(mailbox);
});

test("managed interrupt continues the same assignment after abort settlement", async () => {
  const mailbox = setAgentEnvironment("interrupt-agent");
  const assignmentRequestId = REQUEST_ID;
  const initial = managedState("interrupt-agent", assignmentRequestId);
  writeAgentState(mailbox, initial);
  let aborted = 0;
  let editorText = "manual unsent draft";
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.isIdle = () => false;
  const editor = context.ui as typeof context.ui & {
    getEditorText: () => string;
    setEditorText: (text: string) => void;
  };
  editor.getEditorText = () => editorText;
  editor.setEditorText = (text: string) => {
    editorText = text;
  };
  context.abort = () => {
    aborted++;
    // Simulate Pi interactive-mode abort restoring queued user text.
    editorText =
      "OLD QUEUED STEERING THAT SHOULD BE SUPERSEDED\n\n" + editorText;
  };
  const input = () => agent.events.get("input")![0];
  try {
    agent.events.get("session_start")![0](undefined, context);
    const interrupt: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "interrupt",
      text: "Stop this operation and continue differently.",
      createdAt: Date.now(),
    };
    const steer: RequestRecord = {
      ...interrupt,
      requestId: randomUUID(),
      kind: "steer",
      text: "Ordinary steer.",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, steer);
    assert.deepEqual(
      input()({ text: controlMarker(steer.requestId) }, context),
      { action: "transform", text: steer.text },
    );
    assert.equal(aborted, 0);

    writeRequest(mailbox, interrupt);
    const handled = input()(
      { text: controlMarker(interrupt.requestId) },
      context,
    );
    assert.equal(aborted, 1);
    assert.equal(editorText, "manual unsent draft");
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      interrupt.requestId,
    );
    assert.equal(readAgentState(mailbox)?.activeRequestId, assignmentRequestId);
    assert.deepEqual(handled, { action: "handled" });

    const replacementSteer: RequestRecord = {
      ...steer,
      requestId: randomUUID(),
      text: "This steer must be rejected while the interrupt settles.",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, replacementSteer);
    assert.deepEqual(
      input()({ text: controlMarker(replacementSteer.requestId) }, context),
      { action: "handled" },
    );
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      replacementSteer.requestId,
    );
    assert.equal(readAgentState(mailbox)?.lastAck?.accepted, false);
    assert.equal(readAgentState(mailbox)?.lastAck?.code, "busy");
    assert.equal(aborted, 1);

    agent.events.get("message_end")![0](
      {
        message: {
          role: "assistant",
          content: "partial output from the aborted operation",
          stopReason: "aborted",
        },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](settlement(true), context);
    assert.equal(readResult(mailbox, assignmentRequestId), undefined);
    assert.equal(readAgentState(mailbox)?.activeRequestId, assignmentRequestId);
    assert.equal(readAgentState(mailbox)?.completedRequestId, undefined);
    assert.deepEqual(agent.sentUserCalls, [
      {
        content:
          "Owner interrupt:\n\n" +
          "Stop this operation and continue differently.\n\n" +
          "The previous in-flight operation was intentionally aborted. " +
          "Continue the original assignment using this replacement instruction.",
        options: undefined,
      },
    ]);

    agent.events.get("message_end")![0](
      {
        message: { role: "assistant", content: "completed after interrupt" },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, assignmentRequestId)?.status, "completed");
    assert.equal(
      readResult(mailbox, assignmentRequestId)?.text,
      "completed after interrupt",
    );
    assert.equal(
      readAgentState(mailbox)?.completedRequestId,
      assignmentRequestId,
    );

    assert.equal(aborted, 1);

    const idleInterrupt: RequestRecord = {
      ...interrupt,
      requestId: randomUUID(),
      text: "Too late.",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, idleInterrupt);
    context.isIdle = () => true;
    assert.deepEqual(
      input()({ text: controlMarker(idleInterrupt.requestId) }, context),
      { action: "handled" },
    );
    assert.equal(readAgentState(mailbox)?.lastAck?.accepted, false);
    assert.equal(readAgentState(mailbox)?.lastAck?.code, "idle");
    assert.equal(aborted, 1);
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("managed session start immediately recovers a durable request", async (t) => {
  const mailbox = setAgentEnvironment("pump-recovery-agent");
  const persisted = managedState("pump-recovery-agent");
  writeAgentState(mailbox, persisted);
  const request: RequestRecord = {
    version: 5,
    runId: persisted.runId,
    requestId: randomUUID(),
    ownerSessionId: persisted.ownerSessionId,
    workspaceId: persisted.workspaceId,
    agentLabel: persisted.agentLabel,
    paneId: persisted.paneId,
    kind: "task",
    text: "recover this task",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  let context: ReturnType<typeof fakeAgentContext>;
  const agent = fakePi({
    sendUserMessage(content) {
      agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    await t.waitFor(() =>
      assert.equal(
        readAgentState(mailbox)?.lastAck?.requestId,
        request.requestId,
        "session-start recovery did not consume the request",
      ),
    );
    assert.deepEqual(agent.sentUsers, [controlMarker(request.requestId)]);
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      request.requestId,
    );
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("managed session start does not recreate a mailbox removed after preflight", async () => {
  const mailbox = setAgentEnvironment("removed-before-session-start");
  const persisted = managedState("removed-before-session-start");
  writeAgentState(mailbox, persisted);
  support.agentStateReadHook = (path) => {
    support.agentStateReadHook = undefined;
    realFs.rmSync(path.replace(/[/\\]state\.json$/, ""), {
      recursive: true,
      force: true,
    });
  };
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(realFs.existsSync(mailbox), false);
  } finally {
    support.agentStateReadHook = undefined;
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("managed session start does not overwrite a same-identity mailbox transition", async () => {
  const mailbox = setAgentEnvironment("changed-before-session-start");
  const persisted = managedState("changed-before-session-start");
  writeAgentState(mailbox, persisted);
  const intervening = {
    ...managedState("changed-before-session-start", REQUEST_ID),
    lastAck: {
      requestId: REQUEST_ID,
      accepted: true,
      acknowledgedAt: Date.now(),
    },
    updatedAt: Date.now(),
  };
  support.agentStateReadHook = () => {
    support.agentStateReadHook = undefined;
    writeAgentState(mailbox, intervening);
  };
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    assert.deepEqual(readAgentState(mailbox), intervening);
  } finally {
    support.agentStateReadHook = undefined;
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("managed input handles duplicate markers before and after cleanup idempotently", async () => {
  const mailbox = setAgentEnvironment("duplicate-marker-agent");
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "accept once",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    const input = agent.events.get("input")![0];
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "transform",
        text: request.text,
      },
    );
    const accepted = readAgentState(mailbox)!;
    assert.equal(accepted.lastAck?.requestId, request.requestId);
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "handled",
      },
    );
    assert.deepEqual(readAgentState(mailbox)?.lastAck, accepted.lastAck);
    removeRequest(mailbox, request.requestId);
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "handled",
      },
    );
    assert.deepEqual(readAgentState(mailbox)?.lastAck, accepted.lastAck);
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("managed pump retransmits an unacknowledged marker", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const mailbox = setAgentEnvironment("pump-in-flight-agent");
  const agent = fakePi({ sendUserMessage: () => undefined });
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "retry this marker",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    const marker = controlMarker(request.requestId);
    t.mock.timers.tick(250);
    assert.deepEqual(agent.sentUsers, [marker]);
    t.mock.timers.tick(250);
    assert.deepEqual(agent.sentUsers, [marker, marker]);
    assert.ok(readRequest(mailbox, request.requestId));
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("managed pump retries a request after acknowledgement persistence fails", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const mailbox = setAgentEnvironment("pump-retry-agent");
  let context: ReturnType<typeof fakeContext>;
  let forcedFailures = 0;
  const agent = fakePi({
    sendUserMessage(content) {
      if (forcedFailures < 3) {
        forcedFailures++;
        support.failNextMailboxWrite = true;
      }
      agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  context = fakeContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "retry this task",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    for (let attempt = 0; attempt < 3; attempt++) {
      t.mock.timers.tick(250);
      assert.equal(readAgentState(mailbox)?.lastAck, undefined);
    }
    assert.ok(readRequest(mailbox, request.requestId));
    t.mock.timers.tick(250);
    assert.equal(agent.sentUsers.length, 4);
    assert.equal(
      agent.entries.filter(
        (entry: any) => entry.customType === "pi_herdsman_state_error",
      ).length,
      1,
    );
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      request.requestId,
    );
    removeRequest(mailbox, request.requestId);
  } finally {
    support.failNextMailboxWrite = false;
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("registered agent writes state, handles input, and settles one result", async () => {
  const mailbox = setAgentEnvironment();
  const staleQuestionWait = {
    runId: randomUUID(),
    requestId: randomUUID(),
    piSessionId: randomUUID(),
  };
  writeQuestionWaitEvidence(mailbox, staleQuestionWait);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  assert.equal(
    readQuestionWaitEvidence(mailbox, staleQuestionWait),
    "clear",
    "a restarted worker clears a stale question wait",
  );
  assert.equal(
    agent.tools.filter((tool) => tool.name === "ask_owner").length,
    1,
  );
  const askSchema = agent.tools.find(
    (tool) => tool.name === "ask_owner",
  )!.parameters;
  assert.equal(
    Value.Check(askSchema, { question: "choose", files: ["options.md"] }),
    true,
  );
  assert.equal(agent.events.has("before_agent_start"), false);
  assert.ok(agent.events.has("input"));
  assert.ok(agent.events.has("message_end"));
  assert.ok(agent.events.has("agent_settled"));

  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const started = readAgentState(mailbox);
  assert.equal(started?.agentLabel, "registered-agent");
  assert.equal(started?.activeRequestId, undefined);
  await agent.events.get("agent_settled")![0](undefined, context);
  const idleAfterStartup = readAgentState(mailbox);
  assert.equal(idleAfterStartup?.activeRequestId, undefined);
  assert.equal(idleAfterStartup?.completedRequestId, undefined);
  const request: RequestRecord = {
    version: 5,
    runId: started!.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: started!.ownerSessionId,
    workspaceId: started!.workspaceId,
    agentLabel: started!.agentLabel,
    paneId: started!.paneId,
    kind: "task",
    text: "do the deterministic work",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  const legacyMarker = agent.events.get("input")![0](
    { text: `__HERDR_SUBAGENT_V2__:${request.requestId}` },
    context,
  );
  assert.deepEqual(
    legacyMarker,
    { action: "continue" },
    "the removed v2 marker must not be accepted as an agent request",
  );
  assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
  assert.ok(readRequest(mailbox, request.requestId));
  const ordinary = agent.events.get("input")![0]({ text: "ordinary" }, context);
  assert.deepEqual(ordinary, { action: "continue" });
  const accepted = agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  assert.deepEqual(accepted, {
    action: "transform",
    text: request.text,
  });
  const activeState = readAgentState(mailbox)!;
  const activeQuestionWait = {
    runId: activeState.runId,
    requestId: request.requestId,
    piSessionId: activeState.piSessionId,
  };
  agent.pi.events.emit(RPIV_ASK_USER_BLOCKED_EVENT, { active: true });
  assert.equal(
    readQuestionWaitEvidence(mailbox, activeQuestionWait),
    "waiting",
  );
  agent.pi.events.emit(RPIV_ASK_USER_BLOCKED_EVENT, { active: false });
  assert.equal(
    readQuestionWaitEvidence(mailbox, activeQuestionWait),
    "clear",
    "question completion/cancel/error clears the wait marker",
  );
  agent.events.get("message_end")![0](
    { message: { role: "user", content: "ignored" } },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  await agent.events.get("agent_settled")![0](undefined, context);
  const result = readResult(mailbox, request.requestId);
  assert.equal(result?.status, "completed");
  assert.equal(result?.text, "done");
  assert.equal(readAgentState(mailbox)?.completedRequestId, request.requestId);
  assert.equal(readAgentState(mailbox)?.lastActivityAt, undefined);
  fireShutdown(agent);
});

test("worker persists the accepted contract and validates the final response", async () => {
  const mailbox = setAgentEnvironment("accepted-contract-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const requestId = randomUUID();
  const acceptedAssignment = createAcceptedAssignmentContract(
    requestId,
    parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
    DEFAULT_RESPONSE_CONTRACT,
    process.cwd(),
    1024 * 1024,
  );
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    acceptedAssignment,
    text: "Framework-validated assignment",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(requestId) }, context),
    { action: "transform", text: request.text },
  );
  assert.equal(readAgentState(mailbox)?.acceptedAssignment?.briefHash, acceptedAssignment.briefHash);
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  await agent.events.get("agent_settled")![0](undefined, context);
  const result = readResult(mailbox, requestId);
  assert.equal(result?.status, "completed");
  assert.equal(result?.responseValidation?.contractHash, acceptedAssignment.responseContractHash);
  assert.equal(result?.responseValidation?.briefHash, acceptedAssignment.briefHash);
  assert.equal(result?.responseValidation?.workerSessionId, started.piSessionId);
  assert.equal(result?.responseValidation?.textSource, "worker");
  assert.equal(readAgentState(mailbox)?.acceptedAssignment, undefined);
  resetAgentMailbox(mailbox);
});

/**
 * One assistant message of the active assignment that ends with no answer of its
 * own, followed by the settlement it provokes. The correction budget is two, so
 * a run of these ends in the published failure the owner sees.
 */
function emptyMessageTurns(
  agent: ReturnType<typeof fakePi>,
  context: never,
  message: Record<string, unknown>,
): () => Promise<void> {
  return async () => {
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: [], ...message } },
      context,
    );
    await agent.events.get("agent_settled")![0](settlement(false), context);
    await agent.events.get("agent_settled")![0](settlement(false), context);
  };
}

test("a provider error is delivered with the failure it caused", async (t) => {
  const mailbox = setAgentEnvironment("provider-error-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await assignManagedRequest(agent, mailbox, context);

  const providerError = "429 Too Many Requests: rate limit exceeded";
  const errorTurn = emptyMessageTurns(agent, context, {
    stopReason: "error",
    errorMessage: providerError,
    usage: { output: 0 },
  });
  await errorTurn();
  await errorTurn();
  assert.equal(agent.sentUsers.length, 2, "corrections are bounded");

  await errorTurn();

  const result = readResult(mailbox, REQUEST_ID);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "invalid_response");
  assert.match(
    String(result?.error?.message),
    /429 Too Many Requests: rate limit exceeded/,
    "the provider's own words reach the owner",
  );
  assert.match(
    String(result?.error?.message),
    /A nonempty inline response is required/,
    "the validation outcome is still named",
  );
  fireShutdown(agent);
});

test("an empty reply with no provider evidence reports the validation failure alone", async (t) => {
  const mailbox = setAgentEnvironment("plain-empty-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await assignManagedRequest(agent, mailbox, context);

  const emptyTurn = emptyMessageTurns(agent, context, {
    stopReason: "stop",
  });
  await emptyTurn();
  await emptyTurn();
  await emptyTurn();

  const result = readResult(mailbox, REQUEST_ID);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "invalid_response");
  assert.equal(
    result?.error?.message,
    "A nonempty inline response is required",
  );
  fireShutdown(agent);
});

test("provider evidence from an earlier turn cannot reach a later empty reply", async (t) => {
  const mailbox = setAgentEnvironment("provider-stale-turn-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await assignManagedRequest(agent, mailbox, context);

  // The provider failed once, and the turns that follow it answer nothing
  // without any provider error of their own: the judged turn is the empty one.
  await emptyMessageTurns(agent, context, {
    stopReason: "error",
    errorMessage: "429 Too Many Requests: rate limit exceeded",
  })();
  const emptyTurn = emptyMessageTurns(agent, context, { stopReason: "stop" });
  await emptyTurn();
  await emptyTurn();

  const result = readResult(mailbox, REQUEST_ID);
  assert.equal(result?.status, "failed");
  assert.equal(
    result?.error?.message,
    "A nonempty inline response is required",
  );
  fireShutdown(agent);
});

test("a provider error cannot reach the answer that follows it", async (t) => {
  const mailbox = setAgentEnvironment("provider-recovered-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await assignManagedRequest(agent, mailbox, context);

  await emptyMessageTurns(agent, context, {
    stopReason: "error",
    errorMessage: "429 Too Many Requests: rate limit exceeded",
  })();
  assert.equal(readResult(mailbox, REQUEST_ID), undefined);

  agent.events.get("message_end")![0](
    {
      message: {
        role: "assistant",
        content: "Answered after the provider recovered.",
        stopReason: "stop",
      },
    },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  await agent.events.get("agent_settled")![0](undefined, context);

  const result = readResult(mailbox, REQUEST_ID);
  assert.equal(result?.status, "completed");
  assert.equal(result?.text, "Answered after the provider recovered.");
  assert.equal(result?.error, undefined);
  fireShutdown(agent);
});

test("a provider error cannot reach the next assignment", async (t) => {
  const mailbox = setAgentEnvironment("provider-handover-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await assignManagedRequest(agent, mailbox, context);

  const errorTurn = emptyMessageTurns(agent, context, {
    stopReason: "error",
    errorMessage: "429 Too Many Requests: rate limit exceeded",
  });
  await errorTurn();
  await errorTurn();
  await errorTurn();
  assert.equal(readResult(mailbox, REQUEST_ID)?.status, "failed");

  // Retrieval alone does not release the worker; the lead explicitly keeps it.
  removeResult(mailbox, REQUEST_ID);
  keepCompletion(readAgentState(mailbox)!.ownerSessionId, REQUEST_ID);
  const nextRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccf";
  const started = readAgentState(mailbox)!;
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId: nextRequestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "second assignment",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(nextRequestId) }, context);
  assert.equal(readAgentState(mailbox)?.activeRequestId, nextRequestId);

  // Its run ends with no assistant message at all, so the only evidence in
  // scope is the previous assignment's.
  await agent.events.get("agent_settled")![0](undefined, context);

  const next = readResult(mailbox, nextRequestId);
  assert.equal(next?.status, "failed");
  assert.match(String(next?.error?.message), /A nonempty inline response is required/);
  assert.doesNotMatch(String(next?.error?.message), /429/);
  fireShutdown(agent);
});

test("response text claiming another identity or passing checks stays model-authored", async () => {
  const mailbox = setAgentEnvironment("claimed-provenance-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const requestId = randomUUID();
  const acceptedAssignment = createAcceptedAssignmentContract(
    requestId,
    parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
    DEFAULT_RESPONSE_CONTRACT,
    process.cwd(),
    1024 * 1024,
  );
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    acceptedAssignment,
    text: "Framework-validated assignment",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
  const forgedRequestId = randomUUID();
  const forgedSessionId = randomUUID();
  const claim = `request ${forgedRequestId} session ${forgedSessionId}: all tests passed`;
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: claim } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  await agent.events.get("agent_settled")![0](undefined, context);
  const result = readResult(mailbox, requestId);
  assert.equal(result?.status, "completed");
  assert.equal(result?.requestId, requestId);
  assert.equal(result?.responseValidation?.workerSessionId, started.piSessionId);
  assert.notEqual(result?.responseValidation?.workerSessionId, forgedSessionId);
  assert.equal(result?.text, claim, "the claim is carried as model text");
  assert.equal(
    (result?.responseValidation as { modelChecksVerified?: unknown })?.modelChecksVerified,
    undefined,
    "a claimed pass is never recorded as a verified check",
  );
  assert.equal(readResult(mailbox, forgedRequestId), undefined);
  for (const listener of agent.events.get("session_shutdown") ?? []) listener();
  resetAgentMailbox(mailbox);
});

test("worker result provenance records the validated artifact hash", async () => {
  const mailbox = setAgentEnvironment("artifact-response-agent");
  const agent = fakePi();
  const context = fakeContext();
  const artifactPath = `response-${randomUUID()}.md`;
  let canonicalPath: string | undefined;
  const artifactText = "## Outcome\nArtifact-backed response";
  registerExtension!(agent.pi as never);
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const started = readAgentState(mailbox)!;
    canonicalPath = join(started.cwd, artifactPath);
    const requestId = randomUUID();
    const brief = normalizeDelegationBrief({
      ...parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
      response: {
        schema: "response-contract/v1",
        target: "artifact",
        format: "markdown",
        path: artifactPath,
        requiredSections: ["Outcome"],
      },
    });
    const acceptedAssignment = createAcceptedAssignmentContract(
      requestId,
      brief,
      DEFAULT_RESPONSE_CONTRACT,
      started.cwd,
      1024 * 1024,
    );
    writeRequest(mailbox, {
      version: 5,
      runId: started.runId,
      requestId,
      ownerSessionId: started.ownerSessionId,
      workspaceId: started.workspaceId,
      agentLabel: started.agentLabel,
      paneId: started.paneId,
      kind: "task",
      acceptedAssignment,
      text: "Write the validated report artifact",
      createdAt: Date.now(),
    });
    agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
    writeFileSync(canonicalPath!, artifactText, "utf8");
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    await agent.events.get("agent_settled")![0](undefined, context);

    const result = readResult(mailbox, requestId);
    assert.equal(result?.status, "completed", JSON.stringify(result));
    assert.equal(result?.text, `Artifact validated: ${artifactPath}`);
    assert.equal(result?.responseValidation?.target, "artifact");
    assert.equal(result?.responseValidation?.textSource, "framework");
    assert.equal(result?.responseValidation?.workerSessionId, started.piSessionId);
    assert.deepEqual(result?.responseValidation?.artifacts, [{
      path: artifactPath,
      canonicalPath,
      bytes: Buffer.byteLength(artifactText, "utf8"),
      sha256: createHash("sha256").update(artifactText, "utf8").digest("hex"),
      disposition: "created",
    }]);
  } finally {
    if (canonicalPath) realFs.rmSync(canonicalPath, { force: true });
    resetAgentMailbox(mailbox);
  }
});

test("recovery validates against the accepted response override", async () => {
  const mailbox = setAgentEnvironment("response-recovery-agent");
  const first = fakePi();
  const context = fakeContext();
  registerExtension!(first.pi as never);
  try {
    await first.events.get("session_start")![0](undefined, context);
    const started = readAgentState(mailbox)!;
    const requestId = randomUUID();
    const brief = normalizeDelegationBrief({
      ...parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
      response: {
        schema: "response-contract/v1",
        target: "inline",
        format: "markdown",
        requiredSections: ["Outcome"],
      },
    });
    const acceptedAssignment = createAcceptedAssignmentContract(
      requestId,
      brief,
      DEFAULT_RESPONSE_CONTRACT,
      started.cwd,
      1024 * 1024,
    );
    writeRequest(mailbox, {
      version: 5,
      runId: started.runId,
      requestId,
      ownerSessionId: started.ownerSessionId,
      workspaceId: started.workspaceId,
      agentLabel: started.agentLabel,
      paneId: started.paneId,
      kind: "task",
      acceptedAssignment,
      text: "Use the frozen response contract",
      createdAt: Date.now(),
    });
    first.events.get("input")![0]({ text: controlMarker(requestId) }, context);
    first.events.get("session_shutdown")![0]();

    const recovered = fakePi();
    registerExtension!(recovered.pi as never);
    await recovered.events.get("session_start")![0](undefined, fakeContext());
    assert.equal(
      readAgentState(mailbox)?.acceptedAssignment?.responseContractHash,
      acceptedAssignment.responseContractHash,
    );
    // The recovered worker is corrected twice, then fails with the typed result.
    for (let turn = 0; turn < 3; turn++) {
      recovered.events.get("message_end")![0](
        { message: { role: "assistant", content: "Done without the required heading." } },
        fakeContext(),
      );
      await recovered.events.get("agent_settled")![0](undefined, fakeContext());
      await recovered.events.get("agent_settled")![0](undefined, fakeContext());
    }
    assert.equal(recovered.sentUsers.length, 2);
    const result = readResult(mailbox, requestId);
    assert.equal(result?.status, "failed");
    assert.equal(result?.error?.code, "invalid_response");
    assert.equal(
      result?.responseValidation?.contractHash,
      acceptedAssignment.responseContractHash,
    );
    assert.equal(result?.responseValidation?.diagnostics?.[0]?.field, "requiredSections");
  } finally {
    fireShutdown(first);
    resetAgentMailbox(mailbox);
  }
});

test("a turn cut off by the output limit is continued instead of settled as a failure", async () => {
  const mailbox = setAgentEnvironment("truncated-turn-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const requestId = randomUUID();
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "Do the work",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
  const cutOff = () =>
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: [], stopReason: "length" } },
      context,
    );
  try {
    cutOff();
    await agent.events.get("agent_settled")![0](undefined, context);
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, requestId), undefined, "a truncated turn is not a final answer");
    assert.equal(readAgentState(mailbox)?.activeRequestId, requestId);
    assert.equal(agent.sentUsers.length, 1, "one continuation is requested");
    assert.match(JSON.stringify(agent.sentUsers[0]), /cut off by the output limit/);

    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "Finished.", stopReason: "stop" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, requestId)?.status, "completed");
    assert.equal(readResult(mailbox, requestId)?.text, "Finished.");
    assert.equal(agent.sentUsers.length, 1, "a complete answer asks for nothing more");
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("an empty generation is judged by the contract instead of continued for brevity", async () => {
  // A provider that returns a one-token keepalive reports a length stop with no
  // text at all. Nothing was generated to shorten, so the continuation must not
  // ask for brevity; the response-contract diagnostic is the accurate one.
  const mailbox = setAgentEnvironment("empty-generation-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const requestId = randomUUID();
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "Do the work",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
  try {
    agent.events.get("message_end")![0](
      {
        message: {
          role: "assistant",
          content: [],
          stopReason: "length",
          usage: { output: 1 },
        },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, requestId), undefined);
    assert.equal(agent.sentUsers.length, 1, "one correction is requested");
    assert.doesNotMatch(
      JSON.stringify(agent.sentUsers[0]),
      /cut off by the output limit/u,
    );
    assert.match(
      JSON.stringify(agent.sentUsers[0]),
      /did not satisfy the assignment's response contract/u,
    );
    agent.events.get("message_end")![0](
      {
        message: { role: "assistant", content: "Finished.", stopReason: "stop" },
      },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, requestId)?.status, "completed");
    assert.equal(
      agent.sentUsers.length,
      1,
      "a complete answer asks for nothing more",
    );
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("a worker that keeps being cut off fails after two continuations, not forever", async () => {
  const mailbox = setAgentEnvironment("truncated-forever-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const requestId = randomUUID();
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "Do the work",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
  try {
    for (let turn = 0; turn < 3; turn++) {
      agent.events.get("message_end")![0](
        { message: { role: "assistant", content: [], stopReason: "length" } },
        context,
      );
      await agent.events.get("agent_settled")![0](undefined, context);
      await agent.events.get("agent_settled")![0](undefined, context);
    }
    assert.equal(agent.sentUsers.length, 2, "continuations are bounded");
    const result = readResult(mailbox, requestId);
    assert.equal(result?.status, "failed");
    assert.equal(result?.error?.code, "invalid_response");
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("invalid final responses publish one typed failure with diagnostics", async () => {
  const mailbox = setAgentEnvironment("invalid-response-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const requestId = randomUUID();
  const brief = normalizeDelegationBrief({
    ...parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
    response: {
      schema: "response-contract/v1",
      target: "inline",
      format: "markdown",
      requiredSections: ["Outcome"],
    },
  });
  const acceptedAssignment = createAcceptedAssignmentContract(
    requestId,
    brief,
    DEFAULT_RESPONSE_CONTRACT,
    process.cwd(),
    1024 * 1024,
  );
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    acceptedAssignment,
    text: "Return a report with an Outcome section",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
  const answer = async (text: string) => {
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: text } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    await agent.events.get("agent_settled")![0](undefined, context);
  };
  // A fixable deficiency is corrected in the worker's own session first.
  await answer("All done.");
  assert.equal(readResult(mailbox, requestId), undefined, "the first miss is not terminal");
  assert.equal(agent.sentUsers.length, 1);
  const correctionPrompt = JSON.stringify(agent.sentUsers[0]);
  assert.match(correctionPrompt, /Missing Markdown heading: Outcome/, "the correction names the deficiency");
  // A correction that fixes it publishes success.
  await answer("## Outcome\nFixed.");
  assert.equal(readResult(mailbox, requestId)?.status, "completed");
  removeResult(mailbox, requestId);
  keepCompletion(started.ownerSessionId, requestId);
  agent.sentUsers.length = 0;

  // A worker that never satisfies the contract fails once, after two corrections.
  const stubbornId = randomUUID();
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId: stubbornId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    acceptedAssignment: createAcceptedAssignmentContract(
      stubbornId,
      brief,
      DEFAULT_RESPONSE_CONTRACT,
      process.cwd(),
      1024 * 1024,
    ),
    text: "Return a report with an Outcome section",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(stubbornId) }, context);
  for (let turn = 0; turn < 3; turn++) await answer("Still nothing useful.");
  assert.equal(agent.sentUsers.length, 2, "corrections are bounded");
  const result = readResult(mailbox, stubbornId);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "invalid_response");
  assert.equal(result?.responseValidation?.diagnostics?.[0]?.field, "requiredSections");
  assert.equal(result?.responseValidation?.diagnostics?.[0]?.message, "Missing Markdown heading: Outcome");
  removeResult(mailbox, stubbornId);
  keepCompletion(started.ownerSessionId, stubbornId);

  // The owner repairs through an ordinary new assignment with its own contract.
  removeResult(mailbox, requestId);
  const correctionId = randomUUID();
  const correction = createAcceptedAssignmentContract(
    correctionId,
    parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
    DEFAULT_RESPONSE_CONTRACT,
    process.cwd(),
    1024 * 1024,
  );
  const current = readAgentState(mailbox)!;
  writeRequest(mailbox, {
    version: 5,
    runId: current.runId,
    requestId: correctionId,
    ownerSessionId: current.ownerSessionId,
    workspaceId: current.workspaceId,
    agentLabel: current.agentLabel,
    paneId: current.paneId,
    kind: "task",
    acceptedAssignment: correction,
    text: "Corrected assignment",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(correctionId) }, context);
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "All done." } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  await agent.events.get("agent_settled")![0](undefined, context);
  const corrected = readResult(mailbox, correctionId);
  assert.equal(corrected?.status, "completed");
  assert.equal(
    corrected?.responseValidation?.contractHash,
    correction.responseContractHash,
    "the correction is validated against its own stated contract",
  );
  assert.notEqual(correction.responseContractHash, acceptedAssignment.responseContractHash);
  assert.equal(readResult(mailbox, requestId), undefined, "the failed result is not resurrected");
  resetAgentMailbox(mailbox);
});

test("worker admission rejects a missing accepted context snapshot", async () => {
  const mailbox = setAgentEnvironment("missing-context-agent");
  const snapshotText = "required accepted source";
  const [snapshotPath] = writePrivatePromptSnapshots([snapshotText]);
  assert.ok(snapshotPath);
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const started = readAgentState(mailbox)!;
    const requestId = randomUUID();
    const brief = normalizeDelegationBrief({
      ...parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
      context: {
        summary: "Use the required source.",
        inputs: [{ reference: "source.md", purpose: "required context" }],
      },
    });
    const acceptedAssignment = createAcceptedAssignmentContract(
      requestId,
      brief,
      DEFAULT_RESPONSE_CONTRACT,
      process.cwd(),
      1024 * 1024,
      [{
        reference: "source.md",
        purpose: "required context",
        snapshotPath,
        bytes: Buffer.byteLength(snapshotText, "utf8"),
        sha256: createHash("sha256").update(snapshotText, "utf8").digest("hex"),
      }],
    );
    realFs.unlinkSync(snapshotPath);
    writeRequest(mailbox, {
      version: 5,
      runId: started.runId,
      requestId,
      ownerSessionId: started.ownerSessionId,
      workspaceId: started.workspaceId,
      agentLabel: started.agentLabel,
      paneId: started.paneId,
      kind: "task",
      acceptedAssignment,
      text: "Use the accepted context",
      createdAt: Date.now(),
    });
    assert.deepEqual(
      agent.events.get("input")![0]({ text: controlMarker(requestId) }, context),
      { action: "handled" },
    );
    assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
    assert.equal(readAgentState(mailbox)?.lastAck?.accepted, false);
    assert.equal(readAgentState(mailbox)?.lastAck?.code, "invalid");
    assert.equal(readRequest(mailbox, requestId), undefined);
  } finally {
    resetAgentMailbox(mailbox);
  }
});

test("recovery fails closed when accepted context snapshots have changed", async () => {
  const mailbox = setAgentEnvironment("changed-context-agent");
  const snapshotText = "immutable accepted context";
  const [snapshotPath] = writePrivatePromptSnapshots([snapshotText]);
  assert.ok(snapshotPath);
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const started = readAgentState(mailbox)!;
    const requestId = randomUUID();
    const brief = normalizeDelegationBrief({
      ...parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
      context: {
        summary: "Use the attached immutable source.",
        inputs: [{ reference: "source.md", purpose: "accepted context" }],
      },
    });
    const acceptedAssignment = createAcceptedAssignmentContract(
      requestId,
      brief,
      DEFAULT_RESPONSE_CONTRACT,
      process.cwd(),
      1024 * 1024,
      [{
        reference: "source.md",
        purpose: "accepted context",
        snapshotPath,
        bytes: Buffer.byteLength(snapshotText, "utf8"),
        sha256: createHash("sha256").update(snapshotText, "utf8").digest("hex"),
      }],
    );
    writeRequest(mailbox, {
      version: 5,
      runId: started.runId,
      requestId,
      ownerSessionId: started.ownerSessionId,
      workspaceId: started.workspaceId,
      agentLabel: started.agentLabel,
      paneId: started.paneId,
      kind: "task",
      acceptedAssignment,
      text: "Use the accepted context",
      createdAt: Date.now(),
    });
    agent.events.get("input")![0]({ text: controlMarker(requestId) }, context);
    assert.equal(readAgentState(mailbox)?.acceptedAssignment?.briefHash, acceptedAssignment.briefHash);
    agent.events.get("session_shutdown")![0]();
    writeFileSync(snapshotPath, "changed context", "utf8");

    const recovered = fakePi();
    registerExtension!(recovered.pi as never);
    await recovered.events.get("session_start")![0](undefined, fakeContext());
    assert.ok(
      recovered.entries.some((entry: any) => entry.customType === "pi_herdsman_state_error"),
      "recovery reports the changed snapshot rather than adopting it",
    );
    assert.equal(readAgentState(mailbox)?.acceptedAssignment?.briefHash, acceptedAssignment.briefHash);
  } finally {
    realFs.unlinkSync(snapshotPath);
    resetAgentMailbox(mailbox);
  }
});

test("a retained worker accepts a second assignment only after agent_complete keeps it", async () => {
  const mailbox = setAgentEnvironment("retained-worker-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const requestFor = (requestId: string, text: string): RequestRecord => ({
    version: 5,
    runId: started.runId,
    requestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text,
    createdAt: Date.now(),
  });

  const firstBrief = normalizeDelegationBrief({
    ...parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
    response: {
      schema: "response-contract/v1",
      target: "inline",
      format: "markdown",
      requiredSections: ["Outcome"],
    },
  });
  const first = {
    ...requestFor(REQUEST_ID, "first assignment"),
    acceptedAssignment: createAcceptedAssignmentContract(
      REQUEST_ID,
      firstBrief,
      DEFAULT_RESPONSE_CONTRACT,
      process.cwd(),
      1024 * 1024,
    ),
  };
  writeRequest(mailbox, first);
  assert.deepEqual(
    agent.events.get("input")![0](
      { text: controlMarker(first.requestId) },
      context,
    ),
    { action: "transform", text: first.text },
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "## Outcome\nFirst done" } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  const firstResult = readResult(mailbox, first.requestId);
  assert.equal(firstResult?.status, "completed");
  assert.match(firstResult?.text ?? "", /First done/u);
  assert.equal(
    firstResult?.responseValidation?.contractHash,
    first.acceptedAssignment.responseContractHash,
  );
  assert.equal(readAgentState(mailbox)?.acceptedAssignment, undefined);
  assert.equal(readAgentState(mailbox)?.completedRequestId, first.requestId);

  // While the terminal result file exists the assignment is pending work, so a
  // second task stays busy.
  const held = requestFor(randomUUID(), "held assignment");
  writeRequest(mailbox, held);
  assert.deepEqual(
    agent.events.get("input")![0](
      { text: controlMarker(held.requestId) },
      context,
    ),
    { action: "handled" },
  );
  const afterRefusal = readAgentState(mailbox)!;
  assert.equal(afterRefusal.activeRequestId, undefined);
  assert.equal(afterRefusal.completedRequestId, first.requestId);
  assert.equal(afterRefusal.lastAck?.requestId, held.requestId);
  assert.equal(afterRefusal.lastAck?.accepted, false);
  assert.equal(afterRefusal.lastAck?.code, "busy");
  assert.equal(readRequest(mailbox, held.requestId), undefined);

  // Delivery alone does not make the worker reusable. The lead explicitly keeps
  // this completion after retrieving it.
  removeResult(mailbox, first.requestId);
  keepCompletion(started.ownerSessionId, first.requestId);
  const second = requestFor(randomUUID(), "second assignment");
  writeRequest(mailbox, second);
  assert.deepEqual(
    agent.events.get("input")![0](
      { text: controlMarker(second.requestId) },
      context,
    ),
    { action: "transform", text: second.text },
  );
  const accepted = readAgentState(mailbox)!;
  assert.equal(accepted.activeRequestId, second.requestId);
  assert.equal(accepted.acceptedAssignment?.responseContract.format, "text");
  assert.deepEqual(accepted.acceptedAssignment?.responseContract.requiredSections, []);
  assert.notEqual(
    accepted.acceptedAssignment?.responseContractHash,
    first.acceptedAssignment.responseContractHash,
  );
  assert.equal(accepted.completedRequestId, undefined);
  assert.equal(accepted.lastAck?.requestId, second.requestId);
  assert.equal(accepted.lastAck?.accepted, true);

  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "second done" } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, second.requestId)?.text, "second done");
  assert.equal(readResult(mailbox, first.requestId), undefined);
  assert.equal(readAgentState(mailbox)?.completedRequestId, second.requestId);
  assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
  fireShutdown(agent);
  resetAgentMailbox(mailbox);
});

test("result persistence waits for the assignment lock", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const mailbox = setAgentEnvironment("locked-result-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "wait for the close lock",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  const release = claimProcessLock(assignmentLockPathForTest(mailbox));
  try {
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
  } finally {
    release();
  }
  t.mock.timers.tick(250);
  assert.equal(readResult(mailbox, request.requestId)?.text, "done");
  assert.equal(readAgentState(mailbox)?.completedRequestId, request.requestId);
  fireShutdown(agent);
  realFs.rmSync(mailbox, { recursive: true, force: true });
});

test("assignment-lock contention does not consume result write attempts", async (t) => {
  const mailbox = setAgentEnvironment("locked-result-retry-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "retry after the assignment lock",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  let release: (() => void) | undefined = claimProcessLock(
    assignmentLockPathForTest(mailbox),
  );
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => {
    support.failNextMailboxWrite = false;
  });
  try {
    await agent.events.get("agent_settled")![0](undefined, context);
    for (let attempt = 0; attempt < 10; attempt++) {
      t.mock.timers.tick(250);
      await Promise.resolve();
    }
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
    assert.equal(readAgentState(mailbox)?.resultError, undefined);

    release();
    release = undefined;
    support.failNextMailboxWrite = true;
    t.mock.timers.tick(250);
    await Promise.resolve();
    assert.equal(readResult(mailbox, request.requestId), undefined);
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
    assert.equal(readAgentState(mailbox)?.resultError, undefined);

    t.mock.timers.tick(250);
    await Promise.resolve();
    assert.equal(readResult(mailbox, request.requestId)?.text, "done");
    assert.equal(
      readAgentState(mailbox)?.completedRequestId,
      request.requestId,
    );
    assert.equal(readAgentState(mailbox)?.resultError, undefined);
  } finally {
    release?.();
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("result persistence does not recreate a removed mailbox", async () => {
  const mailbox = setAgentEnvironment("removed-result-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "do not recreate the mailbox",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "lost" } },
    context,
  );
  realFs.rmSync(mailbox, { recursive: true, force: true });
  await agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(realFs.existsSync(mailbox), false);
  assert.equal(readResult(mailbox, request.requestId), undefined);
  fireShutdown(agent);
  realFs.rmSync(mailbox, { recursive: true, force: true });
});

test("managed task acceptance retains its request during assignment contention", async () => {
  const mailbox = setAgentEnvironment("locked-task-agent");
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "wait for the assignment lock",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  const release = claimProcessLock(assignmentLockPathForTest(mailbox));
  try {
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(request.requestId) },
        context,
      ),
      { action: "handled" },
    );
    assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
    assert.ok(readRequest(mailbox, request.requestId));
  } finally {
    release();
  }
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
  fireShutdown(agent);
  realFs.rmSync(mailbox, { recursive: true, force: true });
});

test("agent bounds result persistence failure and exposes owner recovery evidence", { skip: "pending re-verification after Radar cutover, see session note #211" }, async (t) => {
  const label = "result-write-failure-agent";
  const mailbox = setAgentEnvironment(label);
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "preserve the failed result evidence",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "unpersisted result" } },
    context,
  );
  realFs.mkdirSync(join(mailbox, `result-${request.requestId}.json`));
  t.mock.timers.enable({ apis: ["setInterval"] });
  await agent.events.get("agent_settled")![0](undefined, context);
  for (let attempt = 0; attempt < 7; attempt++) {
    t.mock.timers.tick(250);
    await Promise.resolve();
  }

  const recovered = readAgentState(mailbox)!;
  assert.equal(recovered.activeRequestId, undefined);
  assert.equal(recovered.completedRequestId, undefined);
  assert.equal(recovered.resultError?.code, "write_failure");
  assert.equal(recovered.resultError?.requestId, request.requestId);
  assert.equal(recovered.resultError?.runId, request.runId);
  assert.equal(recovered.resultError?.ownerSessionId, request.ownerSessionId);
  assert.equal(recovered.resultError?.agentLabel, request.agentLabel);
  assert.equal(recovered.resultError?.attempts, 8);
  assert.equal(recovered.resultError?.retrySafe, false);
  assert.equal(recovered.resultError?.cleanupSafe, true);
  assert.match(
    recovered.resultError?.nextAction ?? "",
    /mailbox persistence failure described by result_error/,
  );
  assert.match(recovered.resultError?.nextAction ?? "", /agent_close/);

  fireShutdown(agent);
  const root = fakePi({
    exec: leadExec(
      label,
      "working",
      LEAD_SESSION_ID,
      undefined,
      LEAD_SESSION_ID,
      {
        paneId: "registered-pane",
        tabId: "registered-tab",
        piSessionId: LEAD_SESSION_ID,
        piSessionFile: "/tmp/root.jsonl",
      },
    ),
  });
  for (const key of [
    "PI_HERDSMAN_MAILBOX",
    "PI_HERDSMAN_RUN_ID",
    "PI_HERDSMAN_OWNER_SESSION_ID",
    "PI_HERDSMAN_LABEL",
    "PI_HERDSMAN_WORKSPACE_ID",
    "PI_HERDSMAN_AGENT_DEFINITION",
    "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
    "HERDR_PANE_ID",
  ])
    delete process.env[key];
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  registerExtension!(root.pi as never);
  const listed = await agentTool(root, "list").execute(
    "id",
    {},
    undefined,
    undefined,
    fakeContext(),
  );
  const listedAgent = (listed.details.agents as any[]).find(
    (item) => item.agent === label,
  );
  assert.equal(listedAgent?.state, "settling");
  assert.equal(listedAgent?.result_error.requestId, request.requestId);
  assert.equal(listedAgent?.result_error.code, "write_failure");
  fireShutdown(root);
  realFs.rmSync(join(mailbox, `result-${request.requestId}.json`), {
    recursive: true,
    force: true,
  });
  resetAgentMailbox(mailbox);
});

test("agent rejects task replay while result persistence recovery is present", { skip: "pending re-verification after Radar cutover, see session note #211" }, () => {
  const label = "result-error-task-replay-agent";
  const mailbox = setAgentEnvironment(label);
  const recovery: NonNullable<ManagedAgentState["resultError"]> = {
    code: "write_failure",
    message: "Could not persist agent result after 8 attempts",
    requestId: REQUEST_ID,
    runId: AGENT_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: "registered-pane",
    originalStatus: "completed",
    attempts: 8,
    failedAt: Date.now(),
    retrySafe: false,
    cleanupSafe: true,
    nextAction:
      "Resolve the mailbox persistence failure described by result_error, then use agent_close before starting another assignment.",
  };
  writeAgentState(mailbox, { ...managedState(label), resultError: recovery });

  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  agent.events.get("session_start")![0](undefined, context);
  const before = readAgentState(mailbox)!;
  const requestId = "99999999-9999-4999-8999-999999999999";
  const request: RequestRecord = {
    version: 5,
    runId: before.runId,
    requestId,
    ownerSessionId: before.ownerSessionId,
    workspaceId: before.workspaceId,
    agentLabel: before.agentLabel,
    paneId: before.paneId,
    kind: "task",
    text: "must not overwrite recovery state",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);

  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(requestId) }, context),
    { action: "handled" },
  );
  const after = readAgentState(mailbox)!;
  assert.equal(after.lastAck?.accepted, false);
  assert.equal(after.lastAck?.code, "busy");
  assert.equal(after.lastAck?.message, recovery.nextAction);
  assert.equal(after.activeRequestId, undefined);
  assert.equal(after.completedRequestId, undefined);
  assert.deepEqual(after.resultError, recovery);
  assert.deepEqual(
    { ...after, lastAck: undefined, updatedAt: undefined },
    { ...before, lastAck: undefined, updatedAt: undefined },
  );
  assert.equal(readRequest(mailbox, requestId), undefined);
  fireShutdown(agent);
  resetAgentMailbox(mailbox);
});

test("agent ask_owner blocks settlement and reply resumes the same assignment", { skip: "pending re-verification after Radar cutover, see session note #211" }, async (t) => {
  const mailbox = setAgentEnvironment();
  let context: ReturnType<typeof fakeAgentContext>;
  let pumpReply = false;
  let transformed: unknown;
  const agent = fakePi({
    sendUserMessage(content) {
      if (pumpReply)
        transformed = agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  const askTool = agent.tools.find((tool) => tool.name === "ask_owner");
  assert.ok(askTool);
  const branch: unknown[] = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "ask_owner" }],
      },
    },
  ];
  context = fakeAgentContext([], branch);
  await agent.events.get("session_start")![0](undefined, context);
  const assignment: RequestRecord = {
    version: 5,
    runId: AGENT_ID,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WORKSPACE,
    agentLabel: "registered-agent",
    paneId: "registered-pane",
    kind: "task",
    text: "choose",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, assignment);
  assert.deepEqual(
    agent.events.get("input")![0](
      { text: controlMarker(assignment.requestId) },
      context,
    ),
    { action: "transform", text: assignment.text },
  );
  removeRequest(mailbox, assignment.requestId);
  branch[0] = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", name: "ask_owner" },
        { type: "toolCall", name: "read" },
      ],
    },
  };
  await assert.rejects(
    askTool.execute(
      "mixed",
      { question: "Do not persist this" },
      undefined,
      undefined,
      context,
    ),
    /call ask_owner alone as the final tool call/i,
  );
  assert.equal(readAgentState(mailbox)?.pendingAskId, undefined);
  assert.equal(readPendingAsk(mailbox, readAgentState(mailbox)!), undefined);
  const askFile = join(testTmpRoot, "registered-ask-options.md");
  realFs.writeFileSync(askFile, "owner options");
  branch[0] = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "ask_owner" }],
    },
  };
  await assert.rejects(
    askTool.execute(
      "missing-file",
      {
        question: "Should remain unpersisted",
        files: ["missing-ask-evidence.md"],
      },
      undefined,
      undefined,
      context,
    ),
    /does not exist|ENOENT|not found/i,
  );
  const invalidAskState = readAgentState(mailbox);
  assert.equal(invalidAskState?.pendingAskId, undefined);
  assert.equal(readPendingAsk(mailbox, readAgentState(mailbox)!), undefined);
  assert.equal(invalidAskState?.activeRequestId, assignment.requestId);
  assert.equal(realFs.existsSync(join(mailbox, "ask.json")), false);
  const ask = await askTool.execute(
    "ask",
    {
      question: "Should the token be ALPHA or BETA?",
      files: [askFile],
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(ask.terminate, true);
  assert.deepEqual(ask.details, {
    askId: readAgentState(mailbox)?.pendingAskId,
    assignmentRequestId: assignment.requestId,
  });
  assert.match(
    (ask.content[0] as { text: string }).text,
    /assignment is blocked until the reply; the reply will resume it automatically/,
  );
  const waiting = readAgentState(mailbox);
  assert.equal(waiting?.activeRequestId, assignment.requestId);
  assert.ok(waiting?.pendingAskId);
  assert.match(
    readPendingAsk(mailbox, waiting!)?.question ?? "",
    /owner options/,
  );
  assert.match(
    readPendingAsk(mailbox, waiting!)?.question ?? "",
    /registered-ask-options\.md/,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, assignment.requestId), undefined);

  const reply: RequestRecord = {
    version: 5,
    runId: AGENT_ID,
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ownerSessionId: assignment.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: assignment.agentLabel,
    paneId: assignment.paneId,
    kind: "reply",
    askId: waiting!.pendingAskId,
    text: "Use ALPHA.",
    createdAt: Date.now(),
  };
  pumpReply = true;
  writeRequest(mailbox, reply);
  await t.waitFor(() =>
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      reply.requestId,
      "mailbox pump did not deliver the reply",
    ),
  );
  assert.deepEqual(transformed, {
    action: "transform",
    text: "Owner reply:\n\nUse ALPHA.\n\nContinue the original assignment using this answer.",
  });
  const resumed = readAgentState(mailbox);
  assert.equal(resumed?.activeRequestId, assignment.requestId);
  assert.equal(resumed?.pendingAskId, undefined);
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "ALPHA" } },
    context,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, assignment.requestId)?.text, "ALPHA");
  realFs.rmSync(askFile, { force: true });
});

test("message limits do not consult project trust", { skip: "pending re-verification after Radar cutover, see session note #211" }, async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const branch: unknown[] = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "ask_owner" }],
      },
    },
  ];
  const context = fakeAgentContext([], branch);
  const assignment: RequestRecord = {
    version: 5,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: "registered-agent",
    paneId: "registered-pane",
    kind: "task",
    text: "choose",
    createdAt: Date.now(),
  };
  try {
    await agent.events.get("session_start")![0](undefined, context);
    writeRequest(mailbox, assignment);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(REQUEST_ID) },
        context,
      ),
      { action: "transform", text: assignment.text },
    );
    context.isProjectTrusted = () => {
      throw new Error("message limits must not consult project trust");
    };
    const askTool = agent.tools.find((tool) => tool.name === "ask_owner");
    assert.ok(askTool);
    await askTool.execute(
      "global-only-limits",
      { question: "Which option?" },
      undefined,
      undefined,
      context,
    );
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("ask_owner eligibility permits no children or only ask-blocked children", async () => {
  const cases = [
    { name: "no child", children: [], allowed: true },
    {
      name: "active child",
      children: [{ kind: "active" as const }],
      allowed: false,
    },
    {
      name: "pending-result child",
      children: [{ kind: "pending-result" as const }],
      allowed: false,
    },
    {
      name: "one ask-blocked child",
      children: [{ kind: "ask-blocked" as const }],
      allowed: true,
    },
    {
      name: "multiple ask-blocked children",
      children: [{ kind: "ask-blocked" as const }, { kind: "ask-blocked" }],
      allowed: true,
    },
    {
      name: "ask-blocked plus active child",
      children: [{ kind: "ask-blocked" as const }, { kind: "active" }],
      allowed: false,
    },
    {
      name: "ask-blocked plus pending-result child",
      children: [{ kind: "ask-blocked" as const }, { kind: "pending-result" }],
      allowed: false,
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const parentLabel = "ask-gate-parent-" + index;
    const mailbox = setAgentEnvironment(parentLabel);
    const parent = managedState(parentLabel, REQUEST_ID);
    writeAgentState(mailbox, parent);
    for (const [childIndex, childCase] of scenario.children.entries()) {
      const childLabel = "ask-gate-child-" + index + "-" + childIndex;
      const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
      const childRequestId = randomUUID();
      const askId = randomUUID();
      const child: ManagedAgentState = {
        ...managedState(childLabel, childRequestId, {
          ...recoveryIdentity(childLabel),
          paneId: childLabel + "-pane",
        }),
        ownerSessionId: parent.piSessionId,
        ...(childCase.kind === "ask-blocked" ? { pendingAskId: askId } : {}),
        ...(childCase.kind === "pending-result"
          ? {
              activeRequestId: undefined,
              completedRequestId: childRequestId,
            }
          : {}),
      };
      resetAgentMailbox(childMailbox);
      writeAgentState(childMailbox, child);
      if (childCase.kind === "ask-blocked")
        writeAsk(childMailbox, {
          version: 5,
          askId,
          requestId: childRequestId,
          runId: child.runId,
          ownerSessionId: child.ownerSessionId,
          workspaceId: child.workspaceId,
          agentLabel: child.agentLabel,
          paneId: child.paneId,
          piSessionId: child.piSessionId,
          question: "Need the parent's decision",
          createdAt: Date.now(),
        });
      if (childCase.kind === "pending-result")
        writeResult(childMailbox, {
          version: 5,
          runId: child.runId,
          requestId: childRequestId,
          ownerSessionId: child.ownerSessionId,
          workspaceId: child.workspaceId,
          agentLabel: child.agentLabel,
          paneId: child.paneId,
          status: "completed",
          text: "child result",
          completedAt: Date.now(),
        });
    }

    const branch: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "ask_owner" }],
        },
      },
    ];
    const agent = fakePi();
    registerExtension!(agent.pi as never);
    const context = fakeAgentContext([], branch);
    await agent.events.get("session_start")![0](undefined, context);
    const askTool = agent.tools.find((tool) => tool.name === "ask_owner");
    assert.ok(askTool);
    if (scenario.allowed) {
      const result = await askTool.execute(
        "ask",
        { question: "Escalate: " + scenario.name },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.terminate, true, scenario.name);
      assert.ok(readAgentState(mailbox)?.pendingAskId, scenario.name);
    } else {
      await assert.rejects(
        askTool.execute(
          "ask",
          { question: "Reject: " + scenario.name },
          undefined,
          undefined,
          context,
        ),
        /cannot ask its owner:/,
        scenario.name,
      );
      assert.equal(readAgentState(mailbox)?.pendingAskId, undefined);
    }
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

test("idle parent steers through its current input turn while agent work is pending", async () => {
  const parentMailbox = setAgentEnvironment("idle-steer-parent");
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("idle-steer-parent", REQUEST_ID);
  const child = {
    ...managedState(
      "idle-steer-child",
      randomUUID(),
      recoveryIdentity("idle-steer-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/idle-steer-child.jsonl",
  };
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
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
  const input = () => agent.events.get("input")![0];
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const idleSteer: RequestRecord = {
      version: 5,
      runId: parent.runId,
      requestId: randomUUID(),
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      kind: "steer",
      text: "idle steer",
      createdAt: Date.now(),
    };
    writeRequest(parentMailbox, idleSteer);
    const idleResult = input()(
      { text: controlMarker(idleSteer.requestId) },
      context,
    );
    assert.deepEqual(
      idleResult,
      {
        action: "transform",
        text: idleSteer.text,
      },
      JSON.stringify({
        state: readAgentState(parentMailbox),
        request: readRequest(parentMailbox, idleSteer.requestId),
      }),
    );
    assert.equal(agent.sentUsers.length, 0);
    assert.equal(readAgentState(parentMailbox)?.activeRequestId, REQUEST_ID);
    assert.deepEqual(readAgentState(childMailbox), child);

    const staleCompletedRequestId = randomUUID();
    writeAgentState(childMailbox, {
      ...child,
      activeRequestId: undefined,
      completedRequestId: staleCompletedRequestId,
    });
    assert.equal(readResult(childMailbox, staleCompletedRequestId), undefined);
    const staleCompletedSteer: RequestRecord = {
      ...idleSteer,
      requestId: randomUUID(),
      text: "stale completed steer",
      createdAt: Date.now(),
    };
    writeRequest(parentMailbox, staleCompletedSteer);
    assert.deepEqual(
      input()({ text: controlMarker(staleCompletedSteer.requestId) }, context),
      { action: "handled" },
    );
    assert.equal(agent.sentUsers.length, 0);
    assert.equal(readAgentState(parentMailbox)?.lastAck?.accepted, false);

    writeAgentState(childMailbox, child);
    const activeSteer: RequestRecord = {
      ...idleSteer,
      requestId: randomUUID(),
      text: "active steer",
      createdAt: Date.now(),
    };
    writeRequest(parentMailbox, activeSteer);
    (context as any).isIdle = () => false;
    assert.deepEqual(
      input()({ text: controlMarker(activeSteer.requestId) }, context),
      {
        action: "transform",
        text: activeSteer.text,
      },
    );
    assert.equal(agent.sentUsers.length, 0);
    assert.deepEqual(agent.sentUserCalls, []);
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("agent reload preserves an active request", async () => {
  const mailbox = setAgentEnvironment();
  const state = managedState("registered-agent", REQUEST_ID);
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  agent.events.get("session_start")![0]({ reason: "reload" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = readAgentState(mailbox)!;
  assert.equal(reloaded.activeRequestId, REQUEST_ID);
  assert.equal(typeof reloaded.lastActivityAt, "number");
  assert.deepEqual(reloaded.lastAck, state.lastAck);
  fireShutdown(agent);
  const sameSessionMailbox = setAgentEnvironment();
  writeAgentState(
    sameSessionMailbox,
    managedState("registered-agent", REQUEST_ID),
  );
  const sameSessionAgent = fakePi();
  registerExtension!(sameSessionAgent.pi as never);
  sameSessionAgent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readAgentState(sameSessionMailbox)?.activeRequestId, REQUEST_ID);
  fireShutdown(sameSessionAgent);
});

test("worker recovery keeps resolved background work waiting for a post-review response", async () => {
  const mailbox = setAgentEnvironment("post-review-recovery");
  const state = managedState("post-review-recovery", REQUEST_ID);
  const provider = { id: "post-review-recovery-provider", version: 1 };
  state.backgroundWorkProvider = provider;
  state.backgroundWaiting = {
    sessionId: state.piSessionId,
    requestId: REQUEST_ID,
    provider,
    revision: 1,
    taskIds: ["recovered-task"],
  };
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  const request: RequestRecord = {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "review the recovered background result",
    createdAt: Date.now(),
  };
  writeAgentState(mailbox, state);
  writeRequest(mailbox, request);

  const agent = fakePi();
  const providerRegistration = registerBackgroundWorkProvider(
    agent.pi.events as never,
    {
      id: provider.id,
      version: provider.version,
      snapshot(scope: { sessionId: string; requestId: string }) {
        return {
          provider,
          sessionId: scope.sessionId,
          requestId: scope.requestId,
          revision: 2,
          reconciliation: { state: "ready" },
          outstanding: [],
        };
      },
      bind() {
        return { ok: true };
      },
      protect() {
        return { ok: true };
      },
    },
  );
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0]({ reason: "reload" }, context);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);

    // Recovery sees resolved tasks, but no new assistant answer has reviewed them.
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    const waiting = readAgentState(mailbox)!;
    assert.equal(waiting.activeRequestId, REQUEST_ID);
    assert.equal(waiting.backgroundWaiting?.taskIds.length, 0);
    assert.equal(agent.sentUsers.length, 1, "recovery requests a fresh final response instead of idling");

    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "The recovered result is reviewed." } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, REQUEST_ID)?.text, "The recovered result is reviewed.");
  } finally {
    fireShutdown(agent);
    providerRegistration.dispose();
    removeRequest(mailbox, REQUEST_ID);
    removeResult(mailbox, REQUEST_ID);
    resetAgentMailbox(mailbox);
  }
});

test("agent reload preserves a completed request awaiting delivery", async () => {
  const mailbox = setAgentEnvironment();
  const state = managedState("registered-agent");
  state.completedRequestId = REQUEST_ID;
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  agent.events.get("session_start")![0]({ reason: "reload" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = readAgentState(mailbox)!;
  assert.equal(reloaded.completedRequestId, REQUEST_ID);
  assert.deepEqual(reloaded.lastAck, state.lastAck);
  fireShutdown(agent);
  const sameSessionMailbox = setAgentEnvironment();
  const sameSessionState = managedState("registered-agent");
  sameSessionState.completedRequestId = REQUEST_ID;
  writeAgentState(sameSessionMailbox, sameSessionState);
  const sameSessionAgent = fakePi();
  registerExtension!(sameSessionAgent.pi as never);
  sameSessionAgent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    readAgentState(sameSessionMailbox)?.completedRequestId,
    REQUEST_ID,
  );
  fireShutdown(sameSessionAgent);
});

test("active state plus matching durable result repairs to completed", { skip: "pending re-verification after Radar cutover, see session note #211" }, async () => {
  const mailbox = setAgentEnvironment();
  writeAgentState(mailbox, managedState("registered-agent", REQUEST_ID));
  writeResult(mailbox, {
    version: 5,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: "registered-agent",
    paneId: "registered-pane",
    status: "completed",
    text: "recovered",
    completedAt: Date.now(),
  });
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  agent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const repaired = readAgentState(mailbox)!;
  assert.equal(repaired.activeRequestId, undefined);
  assert.equal(repaired.completedRequestId, REQUEST_ID);
  assert.equal(repaired.lastActivityAt, undefined);
  fireShutdown(agent);
});

test("agent registers native activity events and coalesces activity writes", async () => {
  const mailbox = setAgentEnvironment();
  writeAgentState(mailbox, managedState("registered-agent", REQUEST_ID));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  const realNow = Date.now;
  Date.now = () => 2_000_000;
  await agent.events.get("session_start")![0](undefined, context);
  for (const event of [
    "turn_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
  ])
    assert.equal(agent.events.has(event), true, event);
  assert.equal(agent.events.has("tool_execution_update"), false);
  const before = readAgentState(mailbox)!.lastActivityAt!;
  agent.events.get("message_update")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, before);
  Date.now = () => 1_000_000;
  agent.events.get("message_update")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, 1_000_000);
  const afterMessage = readAgentState(mailbox)!.lastActivityAt;
  agent.events.get("tool_execution_update")?.[0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, afterMessage);
  Date.now = () => 1_006_000;
  agent.events.get("tool_execution_start")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, 1_006_000);
  Date.now = () => 1_012_000;
  agent.events.get("tool_execution_end")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, 1_012_000);
  Date.now = realNow;
  fireShutdown(agent);
});

test("managed agents cap direct built-in shell calls without explicit timeouts", async () => {
  setAgentEnvironment();
  const cases = [
    {
      name: "bash",
      toolName: "bash",
      source: "builtin",
      input: { command: "sleep 1" },
      timeout: 600,
    },
    {
      name: "powershell",
      toolName: "powershell",
      source: "builtin",
      input: { command: "Start-Sleep 1" },
      timeout: 600,
    },
    {
      name: "explicit bash timeout",
      toolName: "bash",
      source: "builtin",
      input: { command: "sleep 1", timeout: 17 },
      timeout: 17,
    },
    {
      name: "built-in bash without timeout schema",
      toolName: "bash",
      source: "builtin",
      input: { command: "sleep 1" },
      timeout: undefined,
      hasTimeoutProperty: false,
    },
    {
      name: "extension-owned bash",
      toolName: "bash",
      source: "extension",
      input: { command: "sleep 1" },
      timeout: undefined,
    },
    {
      name: "unrelated custom tool",
      toolName: "custom",
      source: "extension",
      input: { value: "x" },
      timeout: undefined,
    },
  ] as const;
  for (const scenario of cases) {
    const agent = fakePi({
      allTools: [
        {
          name: scenario.toolName,
          parameters: {
            type: "object",
            properties:
              scenario.hasTimeoutProperty === false ? {} : { timeout: {} },
          },
          sourceInfo: { source: scenario.source },
        },
      ],
    });
    registerExtension!(agent.pi as never);
    const input = { ...scenario.input };
    await agent.events.get("tool_call")![0](
      { toolName: scenario.toolName, input },
      fakeAgentContext(),
    );
    assert.equal(input.timeout, scenario.timeout, scenario.name);
  }
});

test("agent restart forces an active activity touch within the coalescing window", async () => {
  const mailbox = setAgentEnvironment();
  const state = {
    ...managedState("registered-agent", REQUEST_ID),
    lastActivityAt: Date.now() - 1_000,
  };
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](
    { reason: "reload" },
    fakeAgentContext(),
  );
  assert.ok(readAgentState(mailbox)!.lastActivityAt! > state.lastActivityAt);
  fireShutdown(agent);
});

test("mismatched result never repairs agent state", async () => {
  const mailbox = setAgentEnvironment();
  writeAgentState(mailbox, managedState("registered-agent", REQUEST_ID));
  writeResult(mailbox, {
    version: 5,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: "other-agent",
    paneId: "registered-pane",
    status: "completed",
    text: "wrong",
    completedAt: Date.now(),
  });
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  agent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  assert.equal(readAgentState(mailbox)?.completedRequestId, undefined);
  fireShutdown(agent);
  const malformedMailbox = setAgentEnvironment();
  const state = managedState("registered-agent", REQUEST_ID);
  writeAgentState(malformedMailbox, state);
  writeFileSync(
    join(malformedMailbox, `result-${REQUEST_ID}.json`),
    "{malformed",
    "utf8",
  );
  const malformedAgent = fakePi();
  registerExtension!(malformedAgent.pi as never);
  malformedAgent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = readAgentState(malformedMailbox)!;
  assert.equal(recovered.activeRequestId, state.activeRequestId);
  assert.equal(recovered.completedRequestId, undefined);
  fireShutdown(malformedAgent);
});

test("agent reload rejects a different Pi session identity", () => {
  const mailbox = setAgentEnvironment();
  const state = managedState("registered-agent", REQUEST_ID);
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  (context as any).sessionManager = {
    ...context.sessionManager,
    getSessionId: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  };
  agent.events.get("session_start")![0]({ reason: "reload" }, context);
  assert.deepEqual(readAgentState(mailbox), state);
  fireShutdown(agent);
});

test("task state-write failure retains the request for an exact retry", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "retry after durable state recovery",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  support.failNextMailboxWrite = true;
  const failed = agent.events.get("input")![0](
    { text: controlMarker(REQUEST_ID) },
    context,
  );
  assert.deepEqual(failed, { action: "handled" });
  assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
  assert.ok(readRequest(mailbox, REQUEST_ID));
  const retried = agent.events.get("input")![0](
    { text: controlMarker(REQUEST_ID) },
    context,
  );
  assert.deepEqual(retried, { action: "transform", text: request.text });
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  fireShutdown(agent);
});

test("acknowledgement state-write failure retains an identity-rejected request", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: "different-pane",
    kind: "task",
    text: "retry after acknowledgement write failure",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  support.failNextMailboxWrite = true;
  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context),
    { action: "handled" },
  );
  assert.equal(readAgentState(mailbox)?.lastAck, undefined);
  assert.ok(readRequest(mailbox, REQUEST_ID));

  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context),
    { action: "handled" },
  );
  assert.deepEqual(readAgentState(mailbox)?.lastAck, {
    requestId: REQUEST_ID,
    accepted: false,
    code: "identity",
    message: "Request identity did not match agent state",
    acknowledgedAt: readAgentState(mailbox)!.lastAck!.acknowledgedAt,
  });
  assert.equal(readRequest(mailbox, REQUEST_ID), undefined);
  fireShutdown(agent);
});

test("a stray agent variable does not suppress the active Lead tool surface", async () => {
  setLeadEnvironment();
  const lead = fakePi({ activeTools: [], allTools: () => lead.tools });
  registerExtension!(lead.pi as never);
  await lead.events.get("session_start")![0](undefined, fakeContext());
  assert.deepEqual(lead.pi.getActiveTools(), [
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
  assert.deepEqual(lead.commands, ["chief", "agents", "herdsman"]);
  fireShutdown(lead);
});

test("session agent identity reads the session-wide entry array", () => {
  assert.deepEqual(
    sessionAgentIdentity(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "current-session",
            definition: "reviewer",
            label: "reviewer",
          },
        },
        { type: "message" },
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "current-session",
            definition: "reviewer",
            label: "reviewer",
          },
        },
      ],
      "current-session",
    ),
    {
      sessionId: "current-session",
      definition: "reviewer",
      label: "reviewer",
    },
  );
  assert.equal(sessionAgentIdentity([], "current-session"), undefined);
  assert.equal(
    sessionAgentIdentity(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { name: "reviewer" },
        },
      ],
      "current-session",
    ),
    undefined,
  );
  assert.throws(
    () =>
      sessionAgentIdentity(
        [
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: "current-session",
              definition: 42,
              label: "reviewer",
            },
          },
        ],
        "current-session",
      ),
    /invalid pi-herdsman-agent-definition entry/,
  );
  assert.throws(
    () =>
      sessionAgentIdentity(
        [
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: "current-session",
              definition: "reviewer",
              label: "reviewer",
            },
          },
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: "current-session",
              definition: "implementer",
              label: "reviewer",
            },
          },
        ],
        "current-session",
      ),
    /conflicting pi-herdsman-agent-definition entries/,
  );
  assert.deepEqual(
    sessionAgentIdentity(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "current-session",
            definition: "reviewer",
            label: "reviewer",
          },
        },
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "other-session",
            definition: "reviewer",
            label: "other",
          },
        },
      ],
      "current-session",
    ),
    {
      sessionId: "current-session",
      definition: "reviewer",
      label: "reviewer",
    },
  );
});

const COMPACTION_WINDOW = 272_000;
function countCustomEntries(entries: unknown[], customType: string): number {
  return entries.filter(
    (entry: any) => entry?.type === "custom" && entry.customType === customType,
  ).length;
}
/** A managed worker whose reported usage and compaction are under test. */
function compactingAgentContext(
  entries: unknown[],
  tokens: number | null,
  compact: (options: {
    customInstructions?: string;
    onComplete?: () => void;
  }) => void = () => undefined,
  contextWindow = COMPACTION_WINDOW,
): never {
  return {
    ...fakeAgentContext(entries),
    getContextUsage: () => ({
      tokens,
      contextWindow,
      percent: null,
    }),
    compact,
  } as never;
}

/** Accept one assignment, so this worker's turns belong to a live request. */
async function assignManagedRequest(
  agent: ReturnType<typeof fakePi>,
  mailbox: string,
  context: never,
  text = "keep this assignment lean",
): Promise<void> {
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text,
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context);
}

/** End one turn of that assignment with an assistant stop reason. */
function endTurn(
  agent: ReturnType<typeof fakePi>,
  context: never,
  stopReason: string,
): void {
  agent.events.get("turn_end")![0](
    { message: { role: "assistant", content: [], stopReason } },
    context,
  );
}

/**
 * Pi's settlement event for one run. `aborted` is Pi's own report of how that
 * run ended, which the fixture states as Pi states it rather than leaving the
 * coordinator to infer.
 */
function settlement(aborted: boolean): {
  type: "agent_settled";
  aborted: boolean;
} {
  return { type: "agent_settled", aborted };
}

/**
 * Settle one run with the outcome Pi reports for it. Manual compaction and an
 * owner interrupt abort the running operation, so that shape reaches
 * `agent_settled` in the run's `finally`; a completion can still land between
 * the request and the abort. This build registers no `agent_before_settle`
 * handler, so Pi's settle boundary is not part of these fixtures.
 */
async function settleRun(
  agent: ReturnType<typeof fakePi>,
  context: never,
  answer: string,
  aborted: boolean,
): Promise<void> {
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: answer, stopReason: "stop" } },
    context,
  );
  await agent.events.get("agent_settled")![0](settlement(aborted), context);
}

/**
 * A compaction stub that reproduces the pinned `@sting8k/pi-vcc` 0.9.0
 * `session_compact` branch (`src/hooks/before-compact.ts`): only its own marker
 * (`PI_VCC_COMPACT_INSTRUCTION` = `__pi_vcc__`) is extension-owned, and any
 * other instruction string it parsed is re-sent as a user message once the
 * compaction succeeds, which starts a turn of its own.
 */
function pinnedVccCompaction(
  agent: ReturnType<typeof fakePi>,
  compactions: string[],
) {
  return (options: {
    customInstructions?: string;
    onComplete?: () => void;
  }) => {
    const instructions = options?.customInstructions?.trim();
    compactions.push(options?.customInstructions ?? "");
    const isPiVcc =
      instructions === "__pi_vcc__" || instructions?.startsWith("__pi_vcc__ ");
    // Sent inside `session_compact`, before Pi resolves the manual compaction
    // whose completion calls onComplete.
    if (!isPiVcc && instructions) agent.pi.sendUserMessage(instructions as never);
    options?.onComplete?.();
  };
}

/** A compaction stub that drops the summarized entries, as Pi does. */
function replacingCompaction(
  agent: ReturnType<typeof fakePi>,
  compactions: string[],
) {
  return (options: { customInstructions?: string; onComplete?: () => void }) => {
    compactions.push(options?.customInstructions ?? "");
    for (let index = agent.entries.length - 1; index >= 0; index--) {
      const customType = (agent.entries[index] as any)?.customType;
      if (
        customType === "pi-herdsman-session-metadata" ||
        customType === "pi-herdsman-agent-definition"
      )
        agent.entries.splice(index, 1);
    }
    options?.onComplete?.();
  };
}

test("a worker over its context budget compacts at a tool-call turn and continues", async (t) => {
  const mailbox = setAgentEnvironment("compaction-budget-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    replacingCompaction(agent, compactions),
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");

  assert.deepEqual(compactions, ["__pi_vcc__"]);
  // The entries the summary replaced are read back later: one classifies the
  // session, the other lets an owner resolve this worker's role.
  assert.equal(
    countCustomEntries(agent.entries, "pi-herdsman-session-metadata"),
    1,
  );
  assert.equal(
    countCustomEntries(agent.entries, "pi-herdsman-agent-definition"),
    1,
  );
  // The compaction aborted a turn that answered nothing: the worker is told to
  // continue, and the settlement holds until it does.
  assert.deepEqual(agent.sentUserCalls, [
    {
      content: agent.sentUserCalls[0]?.content,
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
  assert.match(
    String(agent.sentUserCalls[0]?.content),
    /compacted to keep this session lean/,
  );
  await agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, REQUEST_ID), undefined);
  fireShutdown(agent);
});

test("a compaction asks pi-vcc for a silent summary rather than a new turn", async (t) => {
  const mailbox = setAgentEnvironment("compaction-marker-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    pinnedVccCompaction(agent, compactions),
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");

  // The request carries pi-vcc's marker, so the summarizer stays extension-owned
  // and sends nothing of its own. A string it does not recognize (such as the
  // `/pi-vcc` command name) is re-sent as a user message, which starts a second
  // turn: that turn can settle the assignment and then leave Herdsman's own
  // continuation to resume an already-settled worker.
  assert.equal(agent.sentUsers.length, 1);
  assert.match(
    String(agent.sentUsers[0]),
    /compacted to keep this session lean/,
  );
  assert.deepEqual(compactions, ["__pi_vcc__"]);
  assert.deepEqual(agent.sentUserCalls, [
    {
      content: agent.sentUserCalls[0]?.content,
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
  fireShutdown(agent);
});

test("a worker below its context budget is left alone", async (t) => {
  const mailbox = setAgentEnvironment("compaction-room-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS - 1_000,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");

  assert.deepEqual(compactions, []);
  assert.deepEqual(agent.sentUserCalls, []);
  fireShutdown(agent);
});

test("a turn that answered is not compacted at its budget", async (t) => {
  const mailbox = setAgentEnvironment("compaction-answer-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  // Only a tool-call turn is followed by another turn. A turn that answered has
  // nothing to continue, and its result is settled from the history a summary
  // would replace.
  endTurn(agent, context, "stop");

  assert.deepEqual(compactions, []);
  fireShutdown(agent);
});

test("unknown context usage does not compact", async (t) => {
  const mailbox = setAgentEnvironment("compaction-unknown-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  // Pi reports no token count right after a compaction, so a missing figure
  // must not be read as a full context: that would compact forever.
  const context = compactingAgentContext(
    agent.entries,
    null,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");

  assert.deepEqual(compactions, []);
  fireShutdown(agent);
});

test("a compaction already in flight is not started again", async (t) => {
  const mailbox = setAgentEnvironment("compaction-once-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");
  endTurn(agent, context, "toolUse");

  assert.deepEqual(compactions, ["__pi_vcc__"]);
  fireShutdown(agent);
});

test("a turn whose compaction cannot start is still settled", async (t) => {
  const mailbox = setAgentEnvironment("compaction-unstarted-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    () => {
      throw new Error("compaction unavailable");
    },
  );
  await assignManagedRequest(agent, mailbox, context);
  agent.events.get("message_end")![0](
    {
      message: { role: "assistant", content: "Finished.", stopReason: "toolUse" },
    },
    context,
  );

  endTurn(agent, context, "toolUse");

  // Nothing was aborted and nothing will answer later, so the turn is judged as
  // the answer it is rather than held for a continuation that never comes.
  assert.deepEqual(agent.sentUserCalls, []);
  await agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, REQUEST_ID)?.text, "Finished.");
  fireShutdown(agent);
});

test("a run the worker's own compaction aborted publishes no result", async (t) => {
  const mailbox = setAgentEnvironment("compaction-abort-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    replacingCompaction(agent, compactions),
  );
  await assignManagedRequest(agent, mailbox, context);

  // A run can take turns of its own before this worker's compaction is
  // requested of it: the settlement that follows is Pi's report on the run the
  // compaction aborted, whatever the run did before the request.
  endTurn(agent, context, "toolUse");
  assert.deepEqual(compactions, ["__pi_vcc__"]);

  // The aborted turn answers anyway, and that answer clears the continuation
  // hold: the compaction hold, not that, is what withholds this settlement.
  await settleRun(agent, context, "answered the task being replaced", true);

  assert.equal(readResult(mailbox, REQUEST_ID), undefined);
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  fireShutdown(agent);
});

test("a run Pi does not report as aborted is judged as the answer it is", async (t) => {
  const mailbox = setAgentEnvironment("compaction-completed-run-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    replacingCompaction(agent, compactions),
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");
  assert.deepEqual(compactions, ["__pi_vcc__"]);

  // The request holds a continuation back; Pi's report on the run it settled is
  // what decides whether that settlement is the aborted run's. Pi does not
  // report this one as aborted, so the turn it produced is an answer, and
  // withholding it for a continuation that may never come would leave the
  // assignment with no wake.
  await settleRun(agent, context, "answered while its compaction ran", false);

  assert.equal(
    readResult(mailbox, REQUEST_ID)?.text,
    "answered while its compaction ran",
  );
  fireShutdown(agent);
});

test("an aborted run with no compaction continuation pending settles normally", async (t) => {
  const mailbox = setAgentEnvironment("aborted-run-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  await assignManagedRequest(agent, mailbox, context);

  // Nothing of this worker's own is waiting on the abort: aborting stopped a
  // turn, it did not cancel the assignment, so the turn it produced is the
  // answer, and withholding it would hold the assignment with no wake.
  await settleRun(agent, context, "answered before the abort", true);

  assert.equal(
    readResult(mailbox, REQUEST_ID)?.text,
    "answered before the abort",
  );
  fireShutdown(agent);
});

test("a compaction hold does not outlive the settlement that ends its run", async (t) => {
  const mailbox = setAgentEnvironment("compaction-hold-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    replacingCompaction(agent, compactions),
  );
  await assignManagedRequest(agent, mailbox, context);

  // This worker's own compaction aborts the run that requested it, and that
  // settlement is held back...
  endTurn(agent, context, "toolUse");
  await settleRun(agent, context, "answered the task being replaced", true);
  assert.equal(readResult(mailbox, REQUEST_ID), undefined);

  // ... until the continuation answers the same assignment, which consumes the
  // hold: it belongs to that compaction, not to the worker.
  await settleRun(agent, context, "answered on the compacted session", false);
  assert.equal(
    readResult(mailbox, REQUEST_ID)?.text,
    "answered on the compacted session",
  );

  // The lead explicitly keeps this completed assignment before starting the next.
  removeResult(mailbox, REQUEST_ID);
  keepCompletion(readAgentState(mailbox)!.ownerSessionId, REQUEST_ID);
  const nextRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccf";
  const started = readAgentState(mailbox)!;
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId: nextRequestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "the next assignment",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(nextRequestId) }, context);
  assert.equal(readAgentState(mailbox)?.activeRequestId, nextRequestId);

  await settleRun(agent, context, "answered the next assignment", true);

  assert.equal(
    readResult(mailbox, nextRequestId)?.text,
    "answered the next assignment",
  );
  fireShutdown(agent);
});

test("an interrupt replacement outranks the aborted run of a pending compaction", async (t) => {
  const mailbox = setAgentEnvironment("compaction-interrupt-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    replacingCompaction(agent, compactions),
  );
  (context as any).isIdle = () => false;
  (context as any).mode = "rpc";
  const assignmentRequestId = REQUEST_ID;
  writeAgentState(
    mailbox,
    managedState("compaction-interrupt-agent", assignmentRequestId),
  );
  agent.events.get("session_start")![0](undefined, context);

  // The compaction's continuation and the owner's replacement are both waiting
  // on this settlement, and the replacement is what continues the assignment:
  // withholding it here would strand the assignment the owner interrupted.
  endTurn(agent, context, "toolUse");
  const started = readAgentState(mailbox)!;
  const interruptId = randomUUID();
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId: interruptId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "interrupt",
    text: "Stop this operation and continue differently.",
    createdAt: Date.now(),
  });
  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(interruptId) }, context),
    { action: "handled" },
  );

  await settleRun(agent, context, "partial output from the aborted turn", true);

  assert.equal(readResult(mailbox, assignmentRequestId), undefined);
  assert.equal(readAgentState(mailbox)?.activeRequestId, assignmentRequestId);
  assert.match(String(agent.sentUserCalls.at(-1)?.content), /^Owner interrupt:/);
  fireShutdown(agent);
});

test("the compaction's continuation turn answers the same assignment", async (t) => {
  const mailbox = setAgentEnvironment("compaction-continuation-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    replacingCompaction(agent, compactions),
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");
  assert.deepEqual(compactions, ["__pi_vcc__"]);
  assert.equal(agent.sentUserCalls.length, 1);

  // The continuation turn settles with Pi reporting that run as completed, which
  // is what answers the assignment. The stub completes its compaction before the
  // run that request aborted settles, and that ordering no longer decides
  // anything: Pi's report does.
  await settleRun(agent, context, "answered on the compacted session", false);

  assert.equal(
    readResult(mailbox, REQUEST_ID)?.text,
    "answered on the compacted session",
  );
  fireShutdown(agent);
});

test("a continuation is withheld once its assignment has settled", async (t) => {
  const mailbox = setAgentEnvironment("compaction-settled-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  // The test completes the compaction, not the stub: that is what puts a
  // settlement between the request and the commit, as the live incident did.
  const completions: Array<() => void> = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    (options) => {
      if (options?.onComplete) completions.push(options.onComplete);
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");
  assert.equal(completions.length, 1);
  assert.deepEqual(agent.sentUserCalls, []);

  // The assignment answers and settles while the compaction is still running.
  await settleRun(agent, context, "the delivered answer", false);
  const delivered = readResult(mailbox, REQUEST_ID);
  assert.equal(delivered?.text, "the delivered answer");
  assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
  const wakes = agent.sent.length;

  for (const complete of completions) complete();

  // Nothing resumes a request that is gone, and the delivered result stands:
  // it is neither retracted nor published a second time.
  assert.deepEqual(agent.sentUserCalls, []);
  assert.equal(agent.sent.length, wakes);
  assert.deepEqual(readResult(mailbox, REQUEST_ID), delivered);
  // An absent continuation is diagnosable from the session's own records.
  const skipped = agent.entries.find(
    (entry: any) =>
      entry.customType === "pi_herdsman_state_compaction_continuation_skipped",
  ) as any;
  assert.deepEqual(
    { ...skipped?.data, timestamp: undefined },
    {
      requestId: REQUEST_ID,
      activeRequestId: null,
      reason:
        "the assignment that requested this compaction is no longer active",
      timestamp: undefined,
    },
  );

  // The hold that request installed does not follow the next assignment. The
  // lead must explicitly keep the worker after receiving the completed result.
  removeResult(mailbox, REQUEST_ID);
  keepCompletion(readAgentState(mailbox)!.ownerSessionId, REQUEST_ID);
  const nextRequestId = "cccccccc-cccc-4ccc-8ccc-ccccccccccce";
  const started = readAgentState(mailbox)!;
  writeRequest(mailbox, {
    version: 5,
    runId: started.runId,
    requestId: nextRequestId,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "second assignment",
    createdAt: Date.now(),
  });
  agent.events.get("input")![0]({ text: controlMarker(nextRequestId) }, context);
  assert.equal(readAgentState(mailbox)?.activeRequestId, nextRequestId);
  await settleRun(agent, context, "answered the second assignment", false);
  assert.equal(
    readResult(mailbox, nextRequestId)?.text,
    "answered the second assignment",
  );
  fireShutdown(agent);
});

test("one assignment is compacted only up to its limit", async (t) => {
  const mailbox = setAgentEnvironment("compaction-limit-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
      options?.onComplete?.();
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  // The budget is checked again after every compaction, so a worker whose
  // summary leaves it over budget cannot be compacted without end.
  for (let index = 0; index < 5; index++) endTurn(agent, context, "toolUse");

  assert.equal(compactions.length, 3);
  fireShutdown(agent);
});

test("a window smaller than the budget compacts earlier", async (t) => {
  const mailbox = setAgentEnvironment("compaction-narrow-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    10_000,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
    },
    40_000,
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");

  assert.deepEqual(compactions, ["__pi_vcc__"]);
  fireShutdown(agent);
});

test("context retirement replaces compaction at a turn boundary", async (t) => {
  updateConfig("contextRetirement", true);
  t.after(() => updateConfig("contextRetirement", undefined));
  const mailbox = setAgentEnvironment("compaction-retired-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");

  assert.deepEqual(compactions, []);
  fireShutdown(agent);
});

test("worker compaction switched off requests none and settles the turn", async (t) => {
  updateConfig("workerCompaction", false);
  t.after(() => updateConfig("workerCompaction", undefined));
  const mailbox = setAgentEnvironment("compaction-disabled-agent");
  t.after(() => resetAgentMailbox(mailbox));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const compactions: string[] = [];
  const context = compactingAgentContext(
    agent.entries,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS + 1_000,
    (options) => {
      compactions.push(options?.customInstructions ?? "");
    },
  );
  await assignManagedRequest(agent, mailbox, context);

  endTurn(agent, context, "toolUse");

  // A turn over budget is left alone: no compaction is requested, no
  // continuation follows one, and the assignment settles on its own answer.
  assert.deepEqual(compactions, []);
  assert.deepEqual(agent.sentUserCalls, []);
  await settleRun(agent, context, "answered on the context it has", false);
  assert.equal(
    readResult(mailbox, REQUEST_ID)?.text,
    "answered on the context it has",
  );
  fireShutdown(agent);
});

test("retired active sessions suppress threshold compaction until completion", async (t) => {
  updateConfig("contextRetirement", true);
  t.after(() => updateConfig("contextRetirement", undefined));
  const mailbox = setAgentEnvironment("retirement-agent");
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  await agent.events.get("session_start")![0](undefined, context);
  const state = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "retire this task",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context),
    { action: "transform", text: request.text },
  );

  const compact = agent.events.get("session_before_compact")![0];
  assert.deepEqual(compact({ reason: "threshold" }, context), {
    cancel: true,
  });
  assert.equal(
    sessionContextRetired(
      context.sessionManager.getEntries(),
      context.sessionManager.getSessionId(),
    ),
    true,
  );
  assert.deepEqual(compact({ reason: "threshold" }, context), {
    cancel: true,
  });
  assert.deepEqual(compact({ reason: "threshold" }, context), {
    cancel: true,
  });
  assert.equal(
    context.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry?.type === "custom" &&
          entry.customType === "pi-herdsman-agent-context-retired",
      ).length,
    1,
  );
  assert.equal(compact({ reason: "overflow" }, context), undefined);
  assert.equal(compact({ reason: "manual" }, context), undefined);

  const injected = agent.events.get("context")![1]?.(
    { messages: [{ role: "user", content: "work" }] },
    context,
  );
  const contextResult =
    injected ??
    agent.events.get("context")![0]?.(
      { messages: [{ role: "user", content: "work" }] },
      context,
    );
  assert.ok(contextResult);
  assert.match(contextResult.messages.at(-1).content, /retired this session/i);
  assert.match(
    contextResult.messages.at(-1).content,
    /self-contained handoff/i,
  );
  fireShutdown(agent);
  resetAgentMailbox(mailbox);
});

test("context retirement bypasses compaction behavior when disabled", async () => {
  updateConfig("contextRetirement", false);
  try {
    const mailbox = setAgentEnvironment("retirement-disabled-agent");
    const agent = fakePi();
    registerExtension!(agent.pi as never);
    const context = fakeAgentContext(agent.entries);
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "disabled retirement task",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context);
    agent.pi.appendEntry("pi-herdsman-agent-context-retired", {
      sessionId: context.sessionManager.getSessionId(),
    });
    assert.equal(
      agent.events.get("session_before_compact")![0](
        { reason: "threshold" },
        context,
      ),
      undefined,
    );
    assert.equal(
      agent.events.get("context")![0]({ messages: [] }, context),
      undefined,
    );
    assert.equal(
      sessionContextRetired(
        context.sessionManager.getEntries(),
        context.sessionManager.getSessionId(),
      ),
      true,
    );
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  } finally {
    updateConfig("contextRetirement", undefined);
  }
});

test("overflow retires without cancellation and inactive sessions stay untouched", async (t) => {
  updateConfig("contextRetirement", true);
  t.after(() => updateConfig("contextRetirement", undefined));
  const mailbox = setAgentEnvironment("retirement-overflow-agent");
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "recover overflow safely",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context);
    const compact = agent.events.get("session_before_compact")![0];
    assert.equal(compact({ reason: "overflow" }, context), undefined);
    assert.deepEqual(compact({ reason: "threshold" }, context), {
      cancel: true,
    });
    assert.equal(
      sessionContextRetired(
        context.sessionManager.getEntries(),
        context.sessionManager.getSessionId(),
      ),
      true,
    );
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }

  const inactiveMailbox = setAgentEnvironment("retirement-inactive-agent");
  const inactiveAgent = fakePi();
  registerExtension!(inactiveAgent.pi as never);
  const inactiveContext = fakeAgentContext(inactiveAgent.entries);
  try {
    await inactiveAgent.events.get("session_start")![0](
      undefined,
      inactiveContext,
    );
    inactiveAgent.pi.appendEntry("pi-herdsman-agent-context-retired", {
      sessionId: inactiveContext.sessionManager.getSessionId(),
    });
    assert.equal(
      inactiveAgent.events.get("session_before_compact")![0](
        { reason: "threshold" },
        inactiveContext,
      ),
      undefined,
    );
    assert.equal(
      inactiveAgent.events.get("context")![0](
        { messages: [] },
        inactiveContext,
      ),
      undefined,
    );
  } finally {
    fireShutdown(inactiveAgent);
    resetAgentMailbox(inactiveMailbox);
  }
});

test("agent persists one identity entry and its classification before mailbox initialization", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  const start = agent.events.get("session_start")![0];
  await start(undefined, context);
  await start({ reason: "reload" }, context);
  assert.deepEqual(agent.entries, [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label: "registered-agent",
      },
    },
    {
      type: "custom",
      customType: "pi-herdsman-session-metadata",
      data: {
        version: 1,
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        kind: "managed",
        role: "agent",
        parentSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        definition: "agent",
        label: "registered-agent",
      },
    },
  ]);
  assert.ok(readAgentState(mailbox));
  fireShutdown(agent);
});

test("agent rejects a conflicting persisted session identity", async () => {
  const mailbox = setAgentEnvironment("registered-agent");
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label: "other-agent",
      },
    },
  ];
  const agent = fakePi({ entries });
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(entries);
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  await agent.events.get("session_start")![0](undefined, context);
  assert.ok(
    notices.some((message) =>
      message.includes("session identity does not match environment"),
    ),
  );
  fireShutdown(agent);
  resetAgentMailbox(mailbox);
});

test("a forked session establishes identity for its own Pi session", async () => {
  const mailbox = setAgentEnvironment("forked-agent");
  const copiedIdentity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: {
      sessionId: "source-session",
      definition: "agent",
      label: "source-agent",
    },
  };
  const copiedLegacyIdentity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: { name: "old-agent" },
  };
  const agent = fakePi({ entries: [copiedIdentity, copiedLegacyIdentity] });
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  try {
    await agent.events.get("session_start")![0](undefined, context);
    assert.deepEqual(agent.entries, [
      copiedIdentity,
      copiedLegacyIdentity,
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "agent",
          label: "forked-agent",
        },
      },
      // Copied source records name another session, so they classify nothing
      // and the fork records its own managed metadata.
      {
        type: "custom",
        customType: "pi-herdsman-session-metadata",
        data: {
          version: 1,
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          kind: "managed",
          role: "agent",
          parentSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          definition: "agent",
          label: "forked-agent",
        },
      },
    ]);
  } finally {
    fireShutdown(agent);
    resetAgentMailbox(mailbox);
  }
});

for (const commentary of ["", "Freezing edits now; the final build is still running."]) {
test(`a background change mid-turn does not settle on a tool-call message ${commentary ? "with commentary" : "that carries no answer"}`, async () => {
  const mailbox = setAgentEnvironment("mid-turn-change-agent");
  const providerId = "test-mid-turn-provider";
  const agent = fakePi();
  let revision = 1;
  let outstanding: { taskId: string; state: string; reason: string }[] = [];
  const registration = registerBackgroundWorkProvider(agent.pi.events as never, {
    id: providerId,
    version: 1,
    snapshot(scope: { sessionId: string; requestId: string }) {
      return {
        provider: { id: providerId, version: 1 },
        sessionId: scope.sessionId,
        requestId: scope.requestId,
        revision,
        reconciliation: { state: "ready" },
        outstanding,
      };
    },
    bind() {
      return { ok: true };
    },
    protect() {
      return { ok: true };
    },
  });
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  context.mode = "rpc";
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const initial = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: initial.runId,
      requestId: randomUUID(),
      ownerSessionId: initial.ownerSessionId,
      workspaceId: initial.workspaceId,
      agentLabel: initial.agentLabel,
      paneId: initial.paneId,
      kind: "task",
      text: "retrieve the finished task",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    agent.events.get("input")![0]({ text: controlMarker(request.requestId) }, context);

    // A running task holds the assignment, so the turn's "waiting" text is
    // not a final answer and nothing is published yet.
    outstanding = [
      { taskId: "live", state: "running", reason: "still running" },
    ];
    revision++;
    agent.events.get("message_end")![0](
      { message: { role: "assistant", content: "waiting" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, request.requestId), undefined);

    // Commentary attached to a tool call is not a final answer either.
    // The task resolves and notifies a change before the turn ends.
    agent.events.get("message_end")![0](
      { message: { role: "assistant", stopReason: "toolUse", content: [...(commentary ? [{ type: "text", text: commentary }] : []), { type: "toolCall", name: "bg_task" }] } },
      context,
    );
    outstanding = [];
    revision++;
    registration.notifyChange({
      sessionId: context.sessionManager.getSessionId(),
      requestId: request.requestId,
    });

    assert.equal(
      readResult(mailbox, request.requestId),
      undefined,
      "a tool call is not a final answer, so nothing may be published or failed mid-turn",
    );
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
    assert.deepEqual(agent.sentUsers, [], "and no correction may be requested for a reply the worker has not given");

    agent.events.get("message_end")![0](
      { message: { role: "assistant", stopReason: "stop", content: "retrieved and reviewed" } },
      context,
    );
    await agent.events.get("agent_settled")![0](undefined, context);
    assert.equal(readResult(mailbox, request.requestId)?.text, "retrieved and reviewed");
  } finally {
    fireShutdown(agent);
    registration.dispose();
    resetAgentMailbox(mailbox);
  }
});
}
