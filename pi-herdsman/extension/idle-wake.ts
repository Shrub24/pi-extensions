/**
 * Starting a run from an idle session.
 *
 * `pi.sendMessage(..., { triggerTurn: true })` runs the turn without
 * `before_agent_start` (earendil-works/pi#5581, #10267): the run is never
 * prepared with the system-prompt options extensions contributed, so its second
 * request rebuilds the prompt from base options, drops those sections mid-run,
 * and re-bills the whole prompt. An idle session is therefore woken by the
 * custom message appended without a trigger and a short user prompt that starts
 * the run through the normal prompt lifecycle. A busy session keeps its steer:
 * that run already carries prepared options.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * The short prompt that starts an idle session's run. It carries no content of
 * its own — the wake is the custom message above it — it only routes the wake
 * through `prompt()` so the run is prepared like a user turn.
 */
export const IDLE_WAKE_PROMPT = "New pi-herdsman notification above.";

type WakeMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type WakeOptions = NonNullable<Parameters<ExtensionAPI["sendMessage"]>[1]>;

/**
 * Whether the live context is idle. A stale, replaced, or throwing context reads
 * as busy, so the delivery keeps the shape it always had.
 */
function contextIsIdle(context: ExtensionContext | null | undefined): boolean {
  if (!context) return false;
  try {
    return context.isIdle() === true;
  } catch {
    return false;
  }
}

/**
 * Deliver one wake. When the session is idle the custom message is appended
 * without a trigger and the run starts through `sendUserMessage`, so the prompt
 * lifecycle prepares it. Anywhere else the caller's options pass through
 * unchanged.
 *
 * Both sends are synchronous, so a rejected delivery throws to the caller at the
 * same point the raw `pi.sendMessage` call did and retry paths keep working.
 */
export function sendWakeMessage(
  pi: ExtensionAPI,
  context: ExtensionContext | null | undefined,
  message: WakeMessage,
  busyOptions: WakeOptions,
): void {
  const sendUserMessage = (
    pi as { sendUserMessage?: (content: string) => void }
  ).sendUserMessage;
  if (typeof sendUserMessage === "function" && contextIsIdle(context)) {
    // Append without a trigger; the user prompt below starts the run.
    pi.sendMessage(message, {});
    sendUserMessage.call(pi, IDLE_WAKE_PROMPT);
    return;
  }
  pi.sendMessage(message, busyOptions);
}
