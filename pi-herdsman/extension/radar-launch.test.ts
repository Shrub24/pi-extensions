import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  RADAR_OBSERVE_CAPABILITY,
  RADAR_REGISTRY_CONTRACT,
  RADAR_SPAWN_CONTRACT,
  createRadarClient,
} from "./radar-client.ts";
import {
  launchRadarWorker,
  observeRadarChild,
  type RadarWorkerLaunch,
} from "./radar-launch.ts";
import { managedAgentPresence } from "./index.ts";
import { readAgentState } from "./mailbox.ts";
import { RADAR_SUBJECT_SOURCE } from "./radar-execution.ts";
import { WORKSPACE, agentMailboxPath, resetRadarState } from "./support.ts";
import { FIXTURE_CHILD_PANE, startFakeRadarDaemon } from "./support-radar.ts";

/**
 * One launch's inputs: a mailbox, the identity its child must repeat, and the
 * literal command the daemon is asked to run.
 */
function launchInputs(
  overrides: Partial<RadarWorkerLaunch> = {},
): RadarWorkerLaunch {
  const label = "review-map";
  const runId = randomUUID();
  const ownerSessionId = randomUUID();
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const generation = randomUUID();
  return {
    request_id: randomUUID(),
    generation,
    parent: { agent_id: randomUUID(), location: { backend: "herdr", pane: "lead-pane" } },
    parent_session_id: randomUUID(),
    executable: "/usr/bin/pi",
    argv: ["--approval-mode", "never"],
    cwd: "/tmp",
    env: {
      // Exactly the overlay the launch call site composes, including the pane
      // this launch is created beside.
      PI_HERDSMAN_PARENT_PANE_ID: "lead-pane",
      PI_HERDSMAN_LAUNCH_GENERATION: generation,
      PI_HERDSMAN_MAILBOX: mailbox,
      PI_HERDSMAN_RUN_ID: runId,
      PI_HERDSMAN_OWNER_SESSION_ID: ownerSessionId,
      PI_HERDSMAN_WORKSPACE_ID: WORKSPACE,
      PI_HERDSMAN_LABEL: label,
      PI_HERDSMAN_AGENT_DEFINITION: "agent",
    },
    mailbox,
    identity: { runId, ownerSessionId, workspaceId: WORKSPACE, agentLabel: label },
    ...overrides,
  };
}

/** A client for one test's own daemon, never the harness's shared one. */
async function withDaemon(
  options: Parameters<typeof startFakeRadarDaemon>[0],
  run: (daemon: Awaited<ReturnType<typeof startFakeRadarDaemon>>) => Promise<void>,
): Promise<void> {
  resetRadarState();
  const daemon = await startFakeRadarDaemon(options);
  try {
    await run(daemon);
  } finally {
    daemon.reset();
    await daemon.close();
  }
}

function clientFor(daemon: { socketPath: string }) {
  return createRadarClient({
    env: { ...process.env, RADAR_CONTROL_SOCKET: daemon.socketPath },
  });
}

test("a spawn the daemon completes and its child acknowledges is ready", async () => {
  await withDaemon({}, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
    if (outcome.kind !== "ready") return;
    const [spawn] = daemon.spawns;
    assert.equal(daemon.spawns.length, 1);
    assert.equal(spawn!.request_id, launch.request_id);
    assert.equal(spawn!.parent, launch.parent.agent_id);
    assert.equal(spawn!.parent_session_id, launch.parent_session_id);
    assert.deepEqual(
      {
        executable: spawn!.executable,
        argv: spawn!.argv,
        cwd: spawn!.cwd,
      },
      { executable: "/usr/bin/pi", argv: ["--approval-mode", "never"], cwd: "/tmp" },
    );
    assert.equal(spawn!.env.PI_HERDSMAN_LAUNCH_GENERATION, launch.generation);
    // The overlay reaches the daemon unchanged, so the child is told which pane
    // it was created beside and cannot mistake an inherited one for its own.
    assert.equal(spawn!.env.PI_HERDSMAN_PARENT_PANE_ID, "lead-pane");
    assert.equal(spawn!.env.PI_HERDSMAN_MAILBOX, launch.mailbox);
    // Readiness is the child's own acknowledgment of this launch, not the pane.
    assert.equal(outcome.value.agent_id, spawn!.agent_id);
    assert.equal(outcome.value.pane_id, FIXTURE_CHILD_PANE);
    assert.equal(outcome.value.state.agentLabel, "review-map");
    assert.equal(outcome.value.state.startupAck?.generation, launch.generation);
    assert.equal(outcome.value.state.paneId, "%2");
  });
});

test("a child that never registers leaves the launch unresolved", async () => {
  await withDaemon({ bind: false }, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 400,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "unresolved", JSON.stringify(outcome));
    if (outcome.kind !== "unresolved") return;
    assert.equal(outcome.request_id, launch.request_id);
    // The one request id is read back, never sent a second time.
    assert.equal(daemon.spawns.length, 1);
  });
});

test("a bound child that never acknowledges its launch stays unresolved", async () => {
  await withDaemon({ acknowledge: false }, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 400,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "unresolved", JSON.stringify(outcome));
    if (outcome.kind !== "unresolved") return;
    assert.match(outcome.message, new RegExp(daemon.spawns[0]!.agent_id!));
    // The pane and the edge are the daemon's records: the launch leaves both
    // standing rather than closing something it cannot prove is its own.
    assert.equal(daemon.spawns.length, 1);
    const state = readAgentState(launch.mailbox);
    assert.equal(state?.startupAck, undefined);
    assert.equal(state?.paneId, "%2");
  });
});

test("the daemon's binding is recorded before the child acknowledges readiness", async () => {
  await withDaemon({ acknowledge: false }, async (daemon) => {
    const bound: Array<{ agent_id: string; pane_id: string }> = [];
    const launch = launchInputs({ onBound: (value) => bound.push(value) });
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 400,
      pollMs: 10,
    });
    // Readiness never happened, and the daemon's own binding still reached the
    // launch's record: that is the fact a reload in this window has to read.
    assert.equal(outcome.kind, "unresolved", JSON.stringify(outcome));
    assert.deepEqual(bound, [
      { agent_id: daemon.spawns[0]!.agent_id!, pane_id: daemon.spawns[0]!.pane },
    ]);
    assert.equal(readAgentState(launch.mailbox)?.startupAck, undefined);
    assert.equal(daemon.spawns.length, 1);
  });
});

test("a binding that cannot be recorded leaves the launch unresolved", async () => {
  await withDaemon({}, async (daemon) => {
    const launch = launchInputs({
      onBound: () => {
        throw new Error("the session entry store is unavailable");
      },
    });
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "unresolved", JSON.stringify(outcome));
    if (outcome.kind !== "unresolved") return;
    // The refusal names the child the daemon bound and says why, and nothing is
    // closed: an unrecorded binding is a launch no later reader could hold.
    assert.match(outcome.message, new RegExp(daemon.spawns[0]!.agent_id!));
    assert.match(outcome.message, /could not be recorded/);
    assert.equal(daemon.spawns.length, 1);
    assert.equal(daemon.closes.size, 0);
  });
});

test("a daemon refusal is a launch that never began", async () => {
  await withDaemon(
    { refuseSpawn: { code: "refused", message: "no pane available" } },
    async (daemon) => {
      const outcome = await launchRadarWorker({
        client: clientFor(daemon),
        launch: launchInputs(),
        timeoutMs: 400,
        pollMs: 10,
      });
      assert.equal(outcome.kind, "refused", JSON.stringify(outcome));
      if (outcome.kind !== "refused") return;
      assert.match(outcome.message, /no pane available/);
      assert.equal(daemon.spawns.length, 0);
    },
  );
});

test("a lost spawn reply is read back under the same request id", async () => {
  await withDaemon({ dropSpawnReply: true }, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    // The edge stands, so the launch is ready: a lost reply is not a failure.
    assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
    assert.equal(daemon.spawns.length, 1);
  });
});

test("a parent registration without a pane is refused before any spawn", async () => {
  await withDaemon({}, async (daemon) => {
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch: launchInputs({ parent: { agent_id: randomUUID() } }),
      timeoutMs: 400,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "refused", JSON.stringify(outcome));
    if (outcome.kind !== "refused") return;
    assert.match(outcome.message, /names no pane/);
    assert.equal(daemon.spawns.length, 0);
  });
});

test("a child whose published binding names another subject is not ready", async () => {
  await withDaemon({}, async (daemon) => {
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch: launchInputs({ observedChildAgent: () => randomUUID() }),
      timeoutMs: 400,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "unresolved", JSON.stringify(outcome));
    assert.equal(daemon.spawns.length, 1);
  });
});

/**
 * The location a launch claims for its child is the pane the daemon created for
 * it, never the pane the child's environment handed it: a daemon-spawned child
 * inherits the pane environment it is launched into, and a child that inherited
 * its parent's coordinates would otherwise be reported as living in the parent's
 * pane.
 */
test("a child that claims its parent's pane instead of the pane it was created in is not ready", async () => {
  await withDaemon({ childPane: "lead-pane" }, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 400,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "unresolved", JSON.stringify(outcome));
    if (outcome.kind !== "unresolved") return;
    // The child acknowledged its own startup, and that statement names a pane
    // this launch did not create for it, so readiness never forms.
    assert.equal(readAgentState(launch.mailbox)?.paneId, "lead-pane");
    assert.match(outcome.message, /lead-pane/);
    assert.ok(outcome.message.includes(FIXTURE_CHILD_PANE), outcome.message);
    assert.equal(daemon.spawns.length, 1);
  });
});

test("a launch whose recorded pane the daemon no longer reports is unresolved", async () => {
  await withDaemon({ locationEvidence: "absent" }, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 400,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "unresolved", JSON.stringify(outcome));
    if (outcome.kind !== "unresolved") return;
    assert.ok(outcome.message.includes(FIXTURE_CHILD_PANE), outcome.message);
    // The launch leaves the edge and the pane it read back standing: an absent
    // pane is not a closed pane, and one request id is never spawned twice.
    assert.equal(daemon.spawns.length, 1);
  });
});

test("child.close carries the caller's own id and replays without a second effect", async () => {
  await withDaemon({}, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
    if (outcome.kind !== "ready") return;
    const client = clientFor(daemon);
    const spawn = daemon.spawns[0]!;
    const closeRequest = {
      request_id: randomUUID(),
      spawn_request_id: launch.request_id,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: spawn.incarnation,
      intent: "complete" as const,
    };
    const closed = await client.childClose(closeRequest);
    assert.equal(closed.ok, true, JSON.stringify(closed));
    if (!closed.ok) return;
    assert.deepEqual(closed.value, { outcome: "completed", pane: FIXTURE_CHILD_PANE });
    // The close-operation UUID is the durable key the daemon recorded, so a lost
    // reply is reconciled by resending this id rather than closing twice.
    assert.deepEqual([...daemon.closes.keys()], [closeRequest.request_id]);
    const replay = await client.childClose(closeRequest);
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(daemon.closes.size, 1);
    // The edge and its binding survive the close: the pane is simply no longer
    // reported, which is not process exit.
    const edge = await client.spawnGet(launch.request_id);
    assert.equal(edge.ok, true, JSON.stringify(edge));
    if (!edge.ok) return;
    assert.equal(edge.value.state, "unresolved");
    assert.equal(edge.value.freshness, "stale");
    assert.equal(edge.value.edge.bound?.agent_id, outcome.value.agent_id);
  });
});

test("child.close replays refuse different content under the same id", async () => {
  await withDaemon({}, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
    if (outcome.kind !== "ready") return;
    const client = clientFor(daemon);
    const spawn = daemon.spawns[0]!;
    const requestId = randomUUID();
    const first = await client.childClose({
      request_id: requestId,
      spawn_request_id: launch.request_id,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: spawn.incarnation,
      intent: "complete",
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const conflicting = await client.childClose({
      request_id: requestId,
      spawn_request_id: launch.request_id,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: spawn.incarnation,
      intent: "cancel",
    });
    assert.equal(conflicting.ok, false);
    if (conflicting.ok) return;
    assert.equal(conflicting.code, "bad_request");
  });
});

test("child.close refuses a child the edge is not bound to", async () => {
  await withDaemon({}, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
    if (outcome.kind !== "ready") return;
    const refused = await clientFor(daemon).childClose({
      request_id: randomUUID(),
      spawn_request_id: launch.request_id,
      // Another child's incarnation names a subject this edge never bound.
      source: RADAR_SUBJECT_SOURCE,
      incarnation: randomUUID(),
      intent: "complete",
    });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.code, "refused");
    assert.equal(daemon.closes.size, 0);
    assert.equal(daemon.spawns[0]!.closed, undefined);
  });
});

test("child.close reports a refusal as an outcome and never a second attempt", async () => {
  await withDaemon({ refuseChildClose: true }, async (daemon) => {
    const launch = launchInputs();
    const outcome = await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
    if (outcome.kind !== "ready") return;
    const requestId = randomUUID();
    const refused = await clientFor(daemon).childClose({
      request_id: requestId,
      spawn_request_id: launch.request_id,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: daemon.spawns[0]!.incarnation,
      intent: "complete",
    });
    assert.equal(refused.ok, true, JSON.stringify(refused));
    if (!refused.ok) return;
    // A positive refusal is a recorded outcome before any effect: the pane is
    // untouched and the same id returns this record.
    assert.equal(refused.value.outcome, "refused");
    assert.match(refused.value.message ?? "", /refused this close/);
    assert.deepEqual([...daemon.closes.keys()], [requestId]);
    assert.equal(daemon.spawns[0]!.closed, undefined);
  });
});

test("spawn.close without the close contract is refused before any pane effect", async () => {
  const capabilities = [
    RADAR_REGISTRY_CONTRACT,
    RADAR_SPAWN_CONTRACT,
    RADAR_OBSERVE_CAPABILITY,
  ];
  await withDaemon({ capabilities }, async (daemon) => {
    const refused = await clientFor(daemon).childClose({
      request_id: randomUUID(),
      spawn_request_id: randomUUID(),
      source: RADAR_SUBJECT_SOURCE,
      incarnation: randomUUID(),
      intent: "complete",
    });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    // The handshake is what says whether this build serves `spawn.close` at all,
    // so a daemon whose backend cannot observe and close is refused here instead
    // of being dialled, and no pane is touched.
    assert.equal(refused.code, "unsupported");
    assert.match(refused.message, /spawn\.close\.v1/);
    assert.equal(daemon.closes.size, 0);
  });
});

/** One ready launch, which is what a child to observe always comes from. */
async function readyLaunch(
  daemon: Parameters<Parameters<typeof withDaemon>[1]>[0],
): Promise<{
  requestId: string;
  agentId: string;
  incarnation: string;
  sessionId: string;
}> {
  const launch = launchInputs();
  const outcome = await launchRadarWorker({
    client: clientFor(daemon),
    launch,
    timeoutMs: 2_000,
    pollMs: 10,
  });
  assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
  if (outcome.kind !== "ready") throw new Error("launch was not ready");
  const spawn = daemon.spawns[0]!;
  return {
    requestId: launch.request_id,
    agentId: outcome.value.agent_id,
    incarnation: spawn.incarnation,
    sessionId: spawn.session_id!,
  };
}

test("a live child is proved by the daemon's current read of its own edge", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    const observation = await observeRadarChild(clientFor(daemon), {
      request_id: child.requestId,
      pane_id: FIXTURE_CHILD_PANE,
      agent_id: child.agentId,
      session_id: child.sessionId,
    });
    assert.equal(observation.kind, "live", JSON.stringify(observation));
    if (observation.kind !== "live") return;
    assert.deepEqual(observation.evidence, {
      request_id: child.requestId,
      agent_id: child.agentId,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: child.incarnation,
      pane_id: FIXTURE_CHILD_PANE,
    });
  });
});

test("a closed pane leaves the child unproved, not dead", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    const closed = await clientFor(daemon).childClose({
      request_id: randomUUID(),
      spawn_request_id: child.requestId,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: child.incarnation,
      intent: "complete",
    });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const observation = await observeRadarChild(clientFor(daemon), {
      request_id: child.requestId,
      pane_id: FIXTURE_CHILD_PANE,
      agent_id: child.agentId,
      session_id: child.sessionId,
    });
    assert.equal(observation.kind, "unknown", JSON.stringify(observation));
    if (observation.kind !== "unknown") return;
    // Pane closure is all a close reports: the edge still names the subject it
    // bound, so nothing here claims the child's process ended.
    assert.match(observation.diagnostic, /does not currently report/);
    const edge = await clientFor(daemon).spawnGet(child.requestId);
    assert.equal(edge.ok, true, JSON.stringify(edge));
    if (!edge.ok) return;
    assert.equal(edge.value.edge.bound?.agent_id, child.agentId);
  });
});

test("a child the daemon observed exiting is not live, however present its pane is", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    // The pane's shell outlives the process that was launched in it, so an
    // observed exit and a reported pane have to be read separately: the child is
    // the process, and the pane is not it.
    daemon.options.exitObservation = "exited";
    const observation = await observeRadarChild(clientFor(daemon), {
      request_id: child.requestId,
      pane_id: FIXTURE_CHILD_PANE,
      agent_id: child.agentId,
      session_id: child.sessionId,
    });
    assert.equal(observation.kind, "unknown", JSON.stringify(observation));
    if (observation.kind !== "unknown") return;
    assert.match(observation.diagnostic, /observed process exit/);
  });
});

test("a read that cannot be made proves nothing about the child", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    const observation = await observeRadarChild(
      createRadarClient({
        env: { ...process.env, PI_RADAR_CONTROL_SOCKET: "/tmp/absent-radar.sock" },
      }),
      {
        request_id: child.requestId,
        pane_id: FIXTURE_CHILD_PANE,
        agent_id: child.agentId,
        session_id: child.sessionId,
      },
    );
    assert.equal(observation.kind, "unknown", JSON.stringify(observation));
    if (observation.kind !== "unknown") return;
    assert.match(observation.diagnostic, /not readable/);
  });
});

test("an edge bound to another child is not this launch's child", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    const observation = await observeRadarChild(clientFor(daemon), {
      request_id: child.requestId,
      pane_id: FIXTURE_CHILD_PANE,
      agent_id: randomUUID(),
      session_id: child.sessionId,
    });
    assert.equal(observation.kind, "unknown", JSON.stringify(observation));
    if (observation.kind !== "unknown") return;
    assert.match(observation.diagnostic, /bound to another subject/);
  });
});

test("a child whose launch never bound a subject is unproved", async () => {
  await withDaemon({ bind: false }, async (daemon) => {
    const launch = launchInputs();
    await launchRadarWorker({
      client: clientFor(daemon),
      launch,
      timeoutMs: 300,
      pollMs: 10,
    });
    const observation = await observeRadarChild(clientFor(daemon), {
      request_id: launch.request_id,
      pane_id: FIXTURE_CHILD_PANE,
      agent_id: undefined,
      session_id: undefined,
    });
    assert.equal(observation.kind, "unknown", JSON.stringify(observation));
    if (observation.kind !== "unknown") return;
    assert.match(observation.diagnostic, /not bound to a child by this launch/);
  });
});

test("a launch that recorded no pane is unproved even where its child runs", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    const observation = await observeRadarChild(clientFor(daemon), {
      request_id: child.requestId,
      pane_id: undefined,
      agent_id: child.agentId,
      session_id: child.sessionId,
    });
    // The daemon does report a pane for this child. That is the daemon's own
    // statement, and it is not this launch's to make: a launch that recorded no
    // pane has no location a read could be held to.
    assert.equal(observation.kind, "unknown", JSON.stringify(observation));
    if (observation.kind !== "unknown") return;
    assert.match(
      observation.diagnostic,
      /without a pane this launch recorded for it/,
    );
  });
});

test("another server's pane with the same number is not this launch's child", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    const observation = await observeRadarChild(clientFor(daemon), {
      request_id: child.requestId,
      // The same raw pane number on a different server. The daemon names the
      // server in its handle, so equal suffixes prove nothing about location.
      pane_id: "tmux:other-server:%2",
      agent_id: child.agentId,
      session_id: child.sessionId,
    });
    assert.equal(observation.kind, "unknown", JSON.stringify(observation));
    if (observation.kind !== "unknown") return;
    assert.match(
      observation.diagnostic,
      /recorded on pane tmux:herdsman-fixture:%2, not on tmux:other-server:%2/,
    );
  });
});

test("a bound child is live only while it publishes the session its mailbox records", async () => {
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    const observe = (session_id: string | undefined) =>
      observeRadarChild(clientFor(daemon), {
        request_id: child.requestId,
        pane_id: FIXTURE_CHILD_PANE,
        agent_id: child.agentId,
        session_id,
      });
    assert.equal(managedAgentPresence(await observe(child.sessionId)).kind, "radar");
    const other = await observe(randomUUID());
    assert.equal(other.kind, "unknown", JSON.stringify(other));
    if (other.kind === "unknown") assert.match(other.diagnostic, /publishing session/);
    const unrecorded = await observe(undefined);
    assert.equal(unrecorded.kind, "unknown", JSON.stringify(unrecorded));
  });
});

test("managed presence takes only the bound child's Radar verdict", async () => {
  const observe = (
    daemon: { socketPath: string },
    child: { requestId: string; agentId: string; sessionId: string },
  ) =>
    observeRadarChild(clientFor(daemon), {
      request_id: child.requestId,
      pane_id: FIXTURE_CHILD_PANE,
      agent_id: child.agentId,
      session_id: child.sessionId,
    });
  await withDaemon({}, async (daemon) => {
    const child = await readyLaunch(daemon);
    assert.equal(managedAgentPresence(await observe(daemon, child)).kind, "radar");
  });
  await withDaemon({ processVerdict: "absent" }, async (daemon) => {
    const child = await readyLaunch(daemon);
    assert.deepEqual(managedAgentPresence(await observe(daemon, child)), {
      kind: "lost",
      processGone: "absent",
    });
  });
  await withDaemon({ processVerdict: "unavailable" }, async (daemon) => {
    const child = await readyLaunch(daemon);
    assert.equal(managedAgentPresence(await observe(daemon, child)).kind, "unknown");
  });
  // Without a launch record this session, agent rows and panes never make a child lost.
  assert.equal(managedAgentPresence(undefined).kind, "unknown");
});
