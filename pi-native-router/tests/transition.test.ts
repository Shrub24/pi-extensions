import { test, expect } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeTransition, flushBridge } from "../src/transition";

function bus() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(name: string, listener: (payload: unknown) => void) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => { set.delete(listener); }; },
    emit(name: string, payload: unknown) { for (const listener of listeners.get(name) ?? []) listener(payload); },
    count(name: string) { return listeners.get(name)?.size ?? 0; },
  };
}
test("abort cleans up an outstanding flush handshake and prevents later result reuse", async () => {
  const events = bus();
  const pi = { events } as unknown as ExtensionAPI;
  const controller = new AbortController();
  const promise = flushBridge(pi, 1000)({ sessionId: "session" }, controller.signal);
  controller.abort();
  await expect(promise).rejects.toThrow("aborted");
  expect(events.count("magic-context:flush-result")).toBe(0);
  events.emit("magic-context:flush-result", { sessionId: "session", status: "success" });
});

test("an awaitable subscriber cannot hang a transition after flush succeeds", async () => {
  const events = bus();
  const pi = { events } as unknown as ExtensionAPI;
  events.on("native-router:before-transition", payload => {
    (payload as { waitUntil(promise: Promise<void>): void }).waitUntil(new Promise<void>(() => {}));
  });
  await expect(beforeTransition(pi, async () => {}, { sessionId: "session", logical: "route/work", from: "a/one", to: "b/one" }, 1)).rejects.toThrow("timed out");
});
