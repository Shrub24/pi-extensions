import { describe, expect, test } from "bun:test";
import { offerWakeConsumer, WAKE_CONSUMER_CLAIM, WAKE_CONSUMER_OFFER, WAKE_CONSUMER_PROTOCOL, type WakeConsumerEventBus } from "../extensions/wake-consumer.js";

function fixture() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const bus: WakeConsumerEventBus = {
    on(channel, handler) { const set = handlers.get(channel) ?? new Set(); set.add(handler); handlers.set(channel, set); return () => set.delete(handler); },
    emit(channel, data) { for (const handler of handlers.get(channel) ?? []) handler(data); },
  };
  return bus;
}

describe("wake consumer", () => {
  test("no claim sends synchronously and preserves send errors", () => {
    const bus = fixture(); let sends = 0; let offered: unknown;
    bus.on(WAKE_CONSUMER_OFFER, (raw) => { offered = raw; });
    offerWakeConsumer({ bus, source: "pi-background-tasks", kind: "soft-timeout", id: "t1", sessionId: "s1", metadata: {}, command: "sleep 60 && echo done", isCurrent: () => true, deliver: () => { sends++; } });
    expect(sends).toBe(1);
    expect((offered as { command?: string }).command).toBe("sleep 60 && echo done");
    let failedSends = 0;
    expect(() => offerWakeConsumer({ bus, source: "pi-background-tasks", kind: "soft-timeout", id: "t1", sessionId: "s1", metadata: {}, isCurrent: () => true, deliver: () => { failedSends++; throw new Error("send failed"); } })).toThrow("send failed");
    expect(failedSends).toBe(1);
  });
  test("a claimed skip consumes this advisory without native delivery", async () => {
    const bus = fixture(); let sends = 0;
    bus.on(WAKE_CONSUMER_OFFER, (raw) => {
      const offer = raw as { token: string };
      bus.emit(WAKE_CONSUMER_CLAIM, { protocol: WAKE_CONSUMER_PROTOCOL, token: offer.token, answer: (answer: (decision: unknown) => void) => queueMicrotask(() => answer("skip")) });
    });
    offerWakeConsumer({ bus, source: "pi-herdsman", kind: "soft-deadline", id: "r1", sessionId: "s1", metadata: { count: 2 }, isCurrent: () => true, deliver: () => { sends++; } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sends).toBe(0);
  });

  test("a stale async release is ignored after its work is invalidated", async () => {
    const bus = fixture(); let sends = 0; let current = true;
    bus.on(WAKE_CONSUMER_OFFER, (raw) => {
      const offer = raw as { token: string };
      bus.emit(WAKE_CONSUMER_CLAIM, { protocol: WAKE_CONSUMER_PROTOCOL, token: offer.token, answer: (answer: (decision: unknown) => void) => queueMicrotask(() => answer("release")) });
    });
    offerWakeConsumer({ bus, source: "pi-background-tasks", kind: "soft-timeout", id: "t1", sessionId: "s1", metadata: {}, isCurrent: () => current, deliver: () => { sends++; } });
    current = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sends).toBe(0);
  });

  test("one synchronous claim may asynchronously release exactly once", async () => {
    const bus = fixture(); let sends = 0;
    bus.on(WAKE_CONSUMER_OFFER, (raw) => {
      const token = (raw as { token: string }).token;
      bus.emit(WAKE_CONSUMER_CLAIM, { protocol: WAKE_CONSUMER_PROTOCOL, token, answer: (answer: (value: unknown) => void) => queueMicrotask(() => answer("release")) });
    });
    offerWakeConsumer({ bus, source: "pi-background-tasks", kind: "soft-timeout", id: "t1", sessionId: "s1", metadata: {}, isCurrent: () => true, deliver: () => { sends++; } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sends).toBe(1);
  });
});
