/**
 * The real worker's own acceptance of an addressed request.
 *
 * The lifecycle suites drive a fixture daemon whose consumer answers for a
 * child; those tests prove what an owner does with an answer, not what the
 * worker does with a request. These tests run the extension's request pump
 * itself, which is the only place the pre-execution refusal and the exact
 * identity echo can be proved.
 *
 * The launch generation is captured when the extension module loads, so this
 * file sets it before anything imports the extension: it is its own test
 * process, and no earlier import can have run.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { beforeEach } from "node:test";

const LAUNCH_GENERATION = randomUUID();
process.env.PI_HERDSMAN_LAUNCH_GENERATION = LAUNCH_GENERATION;
process.env.PI_HERDSMAN_PARENT_PANE_ID = "another-pane";

const {
  DELEGATION_BRIEF_EXAMPLES,
  parseDelegationBrief,
} = await import("./briefs.ts");
const { DEFAULT_RESPONSE_CONTRACT } = await import("./response-contracts.ts");
const { createAcceptedAssignmentContract } = await import(
  "./response-validation.ts"
);
const { radarProcessIncarnation } = await import("./radar-publication.ts");
const { updateConfig } = await import("./config.ts");
const { controlMarker, parseControlMarkerVersion } = await import("./mailbox.ts");
const {
  fakeAgentContext,
  fakePi,
  readAgentState,
  registerExtension,
  resetAgentMailbox,
  setAgentEnvironment,
  startRadarSession,
} = await import("./support.ts");
const support = await import("./support.ts");
const { writeRequest, readRequest, readResult } = await import("./mailbox.ts");
const { readPreparationResult, readCompletion } = await import("./completions.ts");
import type { RequestAddress, RequestRecord } from "./mailbox.ts";
import type { FakeRadarDaemon } from "./support-radar.ts";

// Worker-mode registers more than one session_shutdown listener; tests must run
// them all or a surviving request pump leaks into the next test.
function fireShutdown(agent: {
  events: Map<string, Array<(...args: never[]) => unknown>>;
}): void {
  for (const listener of agent.events.get("session_shutdown") ?? []) listener();
}

beforeEach(() => updateConfig("retainWorkers", false));

/**
 * The worker's own address, assembled the way the daemon sees the process: the
 * subject it registered for this incarnation, the source it registered under,
 * the process-local incarnation, and the generation this launch was spawned
 * with. A test builds the request from this, so the positive case proves the
 * worker holds itself to exactly that address.
 */
async function workerAddress(daemon: FakeRadarDaemon): Promise<RequestAddress> {
  const incarnation = radarProcessIncarnation();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const subject = [...daemon.subjects.entries()].find(
      ([, registered]) => registered.incarnation === incarnation,
    );
    if (subject)
      return {
        subject: subject[0],
        source: String(subject[1].source),
        incarnation,
        generation: LAUNCH_GENERATION,
      };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the worker never registered as a Radar subject");
}

/** Let the worker's own 250 ms request pump see the request. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500));
}

function assignmentRequest(
  mailbox: string,
  address?: RequestAddress,
): RequestRecord {
  const state = readAgentState(mailbox)!;
  const requestId = randomUUID();
  return {
    version: address === undefined ? 5 : 6,
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    acceptedAssignment: createAcceptedAssignmentContract(
      requestId,
      parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
      DEFAULT_RESPONSE_CONTRACT,
      process.cwd(),
      1024 * 1024,
    ),
    briefProfile: "common",
    ...(address === undefined ? {} : { address }),
    text: "addressed assignment",
    createdAt: Date.now(),
  };
}

async function startedWorker(label: string) {
  const mailbox = setAgentEnvironment(label);
  let context: ReturnType<typeof fakeAgentContext>;
  // Pi delivers what the worker sends itself, so the pump's marker reaches the
  // worker's own input handler - the acceptance path under test.
  const worker = fakePi({
    sendUserMessage(content) {
      worker.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(worker.pi as never);
  context = fakeAgentContext(worker.entries);
  context.mode = "rpc";
  await startRadarSession(worker, context);
  return { mailbox, daemon: support.radarDaemon, worker, context };
}

test("the addressed worker runs wrapup without a model turn and acknowledges its durable outcome", async (t) => {
  const { mailbox, daemon, worker, context } = await startedWorker("wrapup-worker");
  try {
    const address = await workerAddress(daemon);
    const assignment = assignmentRequest(mailbox, address);
    writeRequest(mailbox, assignment);
    await t.waitFor(() => assert.equal(readAgentState(mailbox)?.activeRequestId, assignment.requestId));
    for (const listener of worker.events.get("message_end") ?? [])
      await listener({ message: { role: "assistant", content: "The task is complete.\n\nDurable worker handoff." } }, context);
    for (const listener of worker.events.get("agent_settled") ?? []) await listener(undefined, context);
    const state = readAgentState(mailbox)!;
    assert.equal(readResult(mailbox, assignment.requestId)?.status, "completed");
    assert.equal(readCompletion(state.ownerSessionId, assignment.requestId)?.summary, "The task is complete.");
    const completionId = assignment.requestId;
    const beforeWrapup = worker.sentUsers.length;
    let wraps = 0;
    worker.pi.events.on("magic-context:flush", () => {
      worker.pi.events.emit("magic-context:flush-result", { sessionId: context.sessionManager.getSessionId(), status: "success" });
    });
    worker.pi.events.on("magic-context:wrapup", () => {
      wraps++;
      worker.pi.events.emit("magic-context:wrapup-result", { sessionId: context.sessionManager.getSessionId(), status: "success" });
    });
    const request: RequestRecord = {
      ...assignmentRequest(mailbox, await workerAddress(daemon)),
      kind: "wrapup", text: completionId, acceptedAssignment: undefined, briefProfile: undefined,
    };
    writeRequest(mailbox, request);
    await t.waitFor(() => assert.equal(readPreparationResult(state.ownerSessionId, request.requestId)?.status, "success"));
    assert.equal(wraps, 1);
    assert.equal(readAgentState(mailbox)?.lastAck?.accepted, true);
    assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
    assert.equal(readAgentState(mailbox)?.completedRequestId, completionId);
    assert.equal(readRequest(mailbox, request.requestId), undefined);
    assert.equal(worker.sentUsers.length, beforeWrapup + 1);
    // Re-delivering the marker does not re-run context preparation.
    await worker.events.get("input")![0]({ text: controlMarker(request.requestId, 6) }, context);
    assert.equal(wraps, 1);
  } finally { fireShutdown(worker); resetAgentMailbox(mailbox); }
});

test("an unaddressed wrapup request is rejected before it can reach a worker", async () => {
  const { mailbox, worker } = await startedWorker("unaddressed-wrapup-worker");
  try {
    const request: RequestRecord = {
      ...assignmentRequest(mailbox), kind: "wrapup", text: randomUUID(),
      acceptedAssignment: undefined, briefProfile: undefined,
    };
    assert.throws(() => writeRequest(mailbox, request), /Wrapup requires an addressed request/);
  } finally { fireShutdown(worker); resetAgentMailbox(mailbox); }
});

test("a worker refuses an assignment addressed to another incarnation of itself", async () => {
  const { mailbox, daemon, worker } = await startedWorker("addressed-worker");
  try {
    const address = await workerAddress(daemon);
    // Same mailbox, same run, same subject and same launch generation: the
    // answering process is the one this request should have reached, and the
    // incarnation alone says it is not.
    const request = assignmentRequest(mailbox, {
      ...address,
      incarnation: randomUUID(),
    });
    writeRequest(mailbox, request);
    await settle();

    const ack = readAgentState(mailbox)?.lastAck;
    assert.equal(ack?.requestId, request.requestId);
    assert.equal(ack?.accepted, false);
    assert.equal(ack?.code, "identity");
    // The refusal is what reaches the owner; the task itself never runs.
    assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
    assert.deepEqual(worker.sentUsers, [
      controlMarker(request.requestId, request.version),
    ]);
    assert.equal(
      worker.calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
  } finally {
    fireShutdown(worker);
    resetAgentMailbox(mailbox);
  }
});

test("a worker accepts an assignment addressed to its own process and echoes it", async () => {
  const { mailbox, daemon, worker } = await startedWorker("own-address-worker");
  try {
    const address = await workerAddress(daemon);
    const request = assignmentRequest(mailbox, address);
    const marker = controlMarker(request.requestId, request.version);
    assert.deepEqual(parseControlMarkerVersion(marker), {
      requestId: request.requestId,
      version: 6,
    });
    writeRequest(mailbox, request);
    await settle();

    const state = readAgentState(mailbox);
    assert.equal(state?.lastAck?.requestId, request.requestId);
    assert.equal(state?.lastAck?.accepted, true);
    // The accepting process states which process it is, and it is the one the
    // request named.
    assert.deepEqual(state?.lastAck?.identity, address);
    assert.equal(state?.activeRequestId, request.requestId);
  } finally {
    fireShutdown(worker);
    resetAgentMailbox(mailbox);
  }
});

test("an unaddressed V5 assignment is accepted by the same worker", async () => {
  const { mailbox, daemon, worker } = await startedWorker("legacy-worker");
  try {
    const request = assignmentRequest(mailbox);
    assert.equal(request.version, 5);
    writeRequest(mailbox, request);
    await settle();

    const state = readAgentState(mailbox);
    assert.equal(state?.lastAck?.requestId, request.requestId);
    assert.equal(state?.lastAck?.accepted, true);
    assert.equal(state?.lastAck?.identity, undefined);
  } finally {
    fireShutdown(worker);
    resetAgentMailbox(mailbox);
  }
});
