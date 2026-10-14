import assert from "node:assert/strict";
import test from "node:test";
import { sendWakeMessage } from "./idle-wake.ts";
import { fakePi } from "./support.ts";

const MESSAGE = {
  customType: "pi-herdsman-wake",
  content: "wake",
  display: true,
};

const WAKE_OPTIONS = { deliverAs: "followUp", triggerTurn: true } as const;

test("a triggerTurn wake uses Pi's prepared custom-message path", () => {
  const { pi, sentMessageCalls, sentUsers } = fakePi();

  sendWakeMessage(pi as never, MESSAGE as never, WAKE_OPTIONS);

  assert.deepEqual(sentMessageCalls, [{ message: MESSAGE, options: WAKE_OPTIONS }]);
  assert.deepEqual(sentUsers, []);
});

test("steering delivery options pass through unchanged", () => {
  const { pi, sentMessageCalls } = fakePi();
  const steerOptions = { triggerTurn: true, deliverAs: "steer" } as const;

  sendWakeMessage(pi as never, MESSAGE as never, steerOptions);

  assert.deepEqual(sentMessageCalls[0]?.options, steerOptions);
});

test("a claimed soft deadline releases through the native delivery path", async () => {
  const { pi, sentMessageCalls, sentUsers } = fakePi();
  pi.events.on("pi-wake-consumer:v1:offer", (raw: unknown) => {
    const offer = raw as { token: string };
    pi.events.emit("pi-wake-consumer:v1:claim", {
      protocol: "pi-wake-consumer/v1",
      token: offer.token,
      answer: (resolve: (decision: "release" | "skip") => void) => queueMicrotask(() => resolve("release")),
    });
  });

  sendWakeMessage(pi as never, MESSAGE as never, WAKE_OPTIONS, {
    kind: "soft-deadline", id: "request-1", sessionId: "session-1", metadata: { count: 1 }, isCurrent: () => true,
  });
  assert.equal(sentMessageCalls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sentMessageCalls, [{ message: MESSAGE, options: WAKE_OPTIONS }]);
  assert.deepEqual(sentUsers, []);
});
