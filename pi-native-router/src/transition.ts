import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SessionIdentity { sessionId: string }
export interface Transition extends SessionIdentity { logical: string; from: string; to: string }
export type TransitionHook = (transition: Transition, signal?: AbortSignal) => Promise<void>;
export type FlushHook = (session: SessionIdentity, signal?: AbortSignal) => Promise<void>;
export function flushBridge(pi: ExtensionAPI, timeoutMs: number): FlushHook {
  return (session, signal) => new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error("Native router transition aborted"));
    const unsubscribe = pi.events.on("magic-context:flush-result", (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const result = payload as { sessionId?: string; status?: string; reason?: string };
      if (result.sessionId !== session.sessionId) return;
      finish(result.status === "success" ? undefined : new Error(`Magic Context flush refused: ${result.reason ?? result.status}`));
    });
    const timer = setTimeout(() => finish(new Error(`Magic Context flush timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try { pi.events.emit("magic-context:flush", { sessionId: session.sessionId }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
export async function beforeTransition(pi: ExtensionAPI, hook: TransitionHook, transition: Transition, timeoutMs: number, signal?: AbortSignal) {
  const work: Promise<unknown>[] = [];
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Native router transition timed out after ${timeoutMs}ms`)), timeoutMs);
    abort = () => reject(new Error("Native router transition aborted"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    signal?.throwIfAborted();
    pi.events.emit("native-router:before-transition", { ...transition, signal, waitUntil: (promise: Promise<unknown>) => work.push(promise) });
    await Promise.race([Promise.all([hook(transition, signal), ...work]), deadline]);
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener("abort", abort!);
  }
}
