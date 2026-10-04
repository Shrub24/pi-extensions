import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_WAKE_PROMPT, sendWakeMessage } from "./idle-wake.ts";
import { fakeContext, fakePi } from "./support.ts";

const MESSAGE = {
  customType: "pi-herdsman-wake",
  content: "wake",
  display: true,
};

const BUSY_OPTIONS = { deliverAs: "followUp", triggerTurn: true } as const;

test("an idle session appends the wake and starts a prepared run", async () => {
  const { pi, sentMessageCalls, sentUsers } = fakePi();

  await sendWakeMessage(
    pi as never,
    fakeContext() as never,
    MESSAGE as never,
    BUSY_OPTIONS,
  );

  assert.equal(sentMessageCalls.length, 1);
  assert.deepEqual(sentMessageCalls[0].message, MESSAGE);
  // The wake is appended without a trigger; the user prompt starts the run.
  assert.deepEqual(sentMessageCalls[0].options, {});
  assert.deepEqual(sentUsers, [IDLE_WAKE_PROMPT]);
});

test("a busy session keeps the caller's trigger delivery", async () => {
  const { pi, sentMessageCalls, sentUsers } = fakePi();
  const ctx = fakeContext();
  ctx.isIdle = () => false;

  await sendWakeMessage(
    pi as never,
    ctx as never,
    MESSAGE as never,
    BUSY_OPTIONS,
  );

  assert.deepEqual(sentMessageCalls.map((call) => call.options), [
    BUSY_OPTIONS,
  ]);
  assert.deepEqual(sentUsers, []);
});

test("a busy session keeps a steer's trigger and delivery mode", async () => {
  const { pi, sentMessageCalls, sentUsers } = fakePi();
  const ctx = fakeContext();
  ctx.isIdle = () => false;
  const steerOptions = { triggerTurn: true, deliverAs: "steer" } as const;

  await sendWakeMessage(
    pi as never,
    ctx as never,
    MESSAGE as never,
    steerOptions,
  );

  assert.deepEqual(sentMessageCalls.map((call) => call.options), [
    steerOptions,
  ]);
  assert.deepEqual(sentUsers, []);
});

test("a session without a prompt seam keeps the caller's delivery", async () => {
  const { pi, sentMessageCalls, sentUsers } = fakePi();
  (pi as { sendUserMessage?: unknown }).sendUserMessage = undefined;

  await sendWakeMessage(
    pi as never,
    fakeContext() as never,
    MESSAGE as never,
    BUSY_OPTIONS,
  );

  assert.deepEqual(sentMessageCalls.map((call) => call.options), [
    BUSY_OPTIONS,
  ]);
  assert.deepEqual(sentUsers, []);
});

test("a throwing idle probe reads as busy", async () => {
  const { pi, sentMessageCalls } = fakePi();
  const ctx = fakeContext();
  ctx.isIdle = () => {
    throw new Error("stale context");
  };

  await sendWakeMessage(
    pi as never,
    ctx as never,
    MESSAGE as never,
    BUSY_OPTIONS,
  );

  assert.deepEqual(sentMessageCalls.map((call) => call.options), [
    BUSY_OPTIONS,
  ]);
});
