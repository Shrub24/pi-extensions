import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AWAITED_METADATA_TTL_MS,
  awaitedTokenValue,
  createAwaitedFacts,
} from "./awaited-facts.ts";
import {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  PARENT_SESSION_ID,
  REQUEST_ID,
  WORKSPACE,
  agentMailboxPath,
  fakeAgentContext,
  fakeContext,
  fakePi,
  managedState,
  recoveryIdentity,
  registerExtension,
  resetAgentMailbox,
  setAgentEnvironment,
  setLeadEnvironment,
  writeAgentState,
} from "./support.ts";

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const awaitedReports = (calls: string[][]) =>
  calls.filter((args) => args.includes("pi-herdsman:awaited"));

test("awaited values are bounded, terminal-safe and empty when nothing is awaited", () => {
  assert.equal(awaitedTokenValue([]), null);
  assert.equal(awaitedTokenValue([""]), null);
  assert.equal(awaitedTokenValue(["agent:one"]), "agent:one");
  assert.equal(awaitedTokenValue(["agent:one", "owner"]), "agent:one, owner");
  assert.equal(
    awaitedTokenValue(
      Array.from({ length: 12 }, (_, index) => `agent:w${index}`),
    )?.split(", ").length,
    8,
  );
  assert.equal(awaitedTokenValue(["agent:\x1b[31mred\x1b[0m"]), "agent:red");
  assert.equal(awaitedTokenValue(["agent:a\tb"]), "agent:a b");
  const long = awaitedTokenValue(["agent:" + "🙂".repeat(90)]);
  assert.equal([...long!].length, 80);
});

test("a pane awaiting nothing publishes nothing and holds no timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[][] = [];
  const facts = createAwaitedFacts({
    paneId: "w:p2",
    send: async (args) => {
      calls.push(args);
    },
  });
  facts.refresh([]);
  t.mock.timers.tick(AWAITED_METADATA_TTL_MS * 4);
  await drain();
  assert.equal(calls.length, 0);
});

test("awaited facts follow membership, refresh before the TTL and clear when empty", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[][] = [];
  const facts = createAwaitedFacts({
    paneId: "w:p2",
    send: async (args) => {
      calls.push(args);
    },
  });
  facts.refresh(["agent:one"]);
  await drain();
  assert.deepEqual(awaitedReports(calls)[0].slice(0, 7), [
    "pane",
    "report-metadata",
    "w:p2",
    "--source",
    "pi-herdsman:awaited",
    "--ttl-ms",
    String(AWAITED_METADATA_TTL_MS),
  ]);
  assert.ok(awaitedReports(calls)[0].includes("pi_herdsman_awaited=agent:one"));
  facts.refresh(["agent:one"]);
  await drain();
  assert.equal(awaitedReports(calls).length, 1);
  t.mock.timers.tick(AWAITED_METADATA_TTL_MS / 2);
  await drain();
  assert.equal(awaitedReports(calls).length, 2);
  facts.refresh(["agent:one", "agent:two"]);
  await drain();
  assert.equal(awaitedReports(calls).length, 3);
  assert.ok(
    awaitedReports(calls)[2].includes("pi_herdsman_awaited=agent:one, agent:two"),
  );
  facts.refresh([]);
  await drain();
  assert.deepEqual(awaitedReports(calls)[3], [
    "pane",
    "report-metadata",
    "w:p2",
    "--source",
    "pi-herdsman:awaited",
    "--ttl-ms",
    String(AWAITED_METADATA_TTL_MS),
    "--clear-token",
    "pi_herdsman_awaited",
  ]);
  t.mock.timers.tick(AWAITED_METADATA_TTL_MS * 4);
  await drain();
  assert.equal(awaitedReports(calls).length, 4);
  facts.refresh(["agent:one"]);
  await drain();
  assert.equal(awaitedReports(calls).length, 5);
  await facts.clear();
  facts.refresh(["agent:one"]);
  await drain();
  assert.equal(awaitedReports(calls).length, 6);
});

test("a set that arrives while its clear is in flight is republished after it", async () => {
  const calls: string[][] = [];
  let releaseClear!: () => void;
  let clears = 0;
  const facts = createAwaitedFacts({
    paneId: "w:p2",
    send: async (args) => {
      calls.push(args);
      if (args.includes("--clear-token") && ++clears === 1)
        await new Promise<void>((resolve) => {
          releaseClear = resolve;
        });
    },
  });
  facts.refresh(["agent:one"]);
  await drain();
  facts.refresh([]);
  await drain();
  assert.equal(awaitedReports(calls).length, 2);
  facts.refresh(["agent:two"]);
  await drain();
  assert.equal(awaitedReports(calls).length, 2);
  releaseClear();
  await drain();
  assert.equal(awaitedReports(calls).length, 3);
  assert.ok(awaitedReports(calls)[2].includes("pi_herdsman_awaited=agent:two"));
  await facts.clear();
});

test("a failed awaited report surfaces to no caller and retries on the next refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[][] = [];
  const facts = createAwaitedFacts({
    paneId: "w:p2",
    send: async (args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("offline");
    },
  });
  facts.refresh(["agent:one"]);
  await drain();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(AWAITED_METADATA_TTL_MS / 2);
  await drain();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("pi_herdsman_awaited=agent:one"));
  await facts.clear();
});

test("a lead pane advertises its outstanding worker and never a resolved one", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const outstanding = managedState(
    "awaited-worker",
    REQUEST_ID,
    recoveryIdentity("awaited-worker"),
  );
  const retained = managedState(
    "retained-worker",
    undefined,
    recoveryIdentity("retained-worker"),
  );
  const outstandingMailbox = agentMailboxPath(
    WORKSPACE,
    outstanding.agentLabel,
  );
  writeAgentState(outstandingMailbox, outstanding);
  writeAgentState(
    agentMailboxPath(WORKSPACE, retained.agentLabel),
    retained,
  );
  const pi = fakePi();
  const context = fakeContext() as any;
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, context);
    await drain();
    const reports = awaitedReports(pi.calls);
    const sourced = reports.find((args) =>
      args.includes("pi_herdsman_awaited=agent:awaited-worker"),
    );
    assert.ok(sourced, JSON.stringify(reports));
    assert.equal(sourced[2], "lead-pane");
    assert.equal(
      sourced[sourced.indexOf("--source") + 1],
      "pi-herdsman:awaited",
    );
    assert.equal(
      sourced[sourced.indexOf("--ttl-ms") + 1],
      String(AWAITED_METADATA_TTL_MS),
    );
    assert.ok(
      !reports.some((args) =>
        args.some((value) => value.includes("retained-worker")),
      ),
      "a retained worker with no outstanding work is not awaited",
    );
    writeAgentState(outstandingMailbox, {
      ...outstanding,
      activeRequestId: undefined,
    });
    await pi.events.get("session_info_changed")![0]({ name: "lead" }, context);
    await drain();
    assert.ok(
      awaitedReports(pi.calls).some(
        (args) =>
          args.includes("--clear-token") &&
          args.includes("pi_herdsman_awaited"),
      ),
      JSON.stringify(awaitedReports(pi.calls)),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    setLeadEnvironment();
  }
});

test("a worker pane advertises nested children while working and clears when they resolve", async () => {
  const mailbox = setAgentEnvironment("awaited-parent");
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, {
    ...managedState("awaited-parent", REQUEST_ID),
    pendingAskId: randomUUID(),
  });
  const active = {
    ...managedState(
      "awaited-child",
      REQUEST_ID,
      recoveryIdentity("awaited-child"),
    ),
    ownerSessionId: DEFAULT_PI_SESSION_ID,
    piSessionId: CHILD_SESSION_ID,
  };
  const resolved = {
    ...managedState(
      "retained-child",
      undefined,
      recoveryIdentity("retained-child"),
    ),
    ownerSessionId: DEFAULT_PI_SESSION_ID,
    piSessionId: PARENT_SESSION_ID,
  };
  const activeMailbox = agentMailboxPath(WORKSPACE, active.agentLabel);
  writeAgentState(activeMailbox, active);
  writeAgentState(agentMailboxPath(WORKSPACE, resolved.agentLabel), resolved);
  const pi = fakePi();
  const context = fakeAgentContext() as any;
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, context);
    await drain();
    assert.ok(
      awaitedReports(pi.calls).some((args) =>
        args.includes("pi_herdsman_awaited=agent:awaited-child, owner"),
      ),
      JSON.stringify(awaitedReports(pi.calls)),
    );
    writeAgentState(activeMailbox, {
      ...active,
      activeRequestId: undefined,
    });
    writeAgentState(mailbox, {
      ...managedState("awaited-parent", REQUEST_ID),
      pendingAskId: undefined,
    });
    await pi.events.get("turn_end")![0](undefined, context);
    await drain();
    assert.ok(
      awaitedReports(pi.calls).some(
        (args) =>
          args.includes("--clear-token") &&
          args.includes("pi_herdsman_awaited"),
      ),
      JSON.stringify(awaitedReports(pi.calls)),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    setLeadEnvironment();
  }
});

test("a pane outside TUI or Herdr publishes no awaited facts", async () => {
  const mailbox = setAgentEnvironment("awaited-parent");
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState("awaited-parent", REQUEST_ID));
  writeAgentState(agentMailboxPath(WORKSPACE, "awaited-child"), {
    ...managedState(
      "awaited-child",
      REQUEST_ID,
      recoveryIdentity("awaited-child"),
    ),
    ownerSessionId: DEFAULT_PI_SESSION_ID,
  });
  const pi = fakePi();
  const context = fakeAgentContext() as any;
  const withoutHerdr = { ...context, mode: "print" };
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, withoutHerdr);
    const herdrEnv = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    await pi.events.get("session_start")![0](undefined, context);
    process.env.HERDR_ENV = herdrEnv;
    await drain();
    assert.deepEqual(awaitedReports(pi.calls), []);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    setLeadEnvironment();
  }
});
