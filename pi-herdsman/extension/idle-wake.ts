/** Central delivery path for native wakes, with optional advisory interception. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { offerWakeConsumer, type WakeConsumerEventBus } from "./advisory-wake.ts";

type WakeMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type WakeOptions = NonNullable<Parameters<ExtensionAPI["sendMessage"]>[1]>;

/**
 * Deliver one wake through Pi's native custom-message path. Pi 1.2.0 prepares
 * triggerTurn runs through before_agent_start; the caller's options pass through.
 */
export function sendWakeMessage(
  pi: ExtensionAPI,
  message: WakeMessage,
  options: WakeOptions,
  advisory?: { kind: "soft-deadline"; id: string; sessionId: string; metadata: Record<string, string | number | boolean | null>; dispatchGuidance?: string; isCurrent: () => boolean; onError?: (reason: string) => void },
): void {
  const native = (): void => pi.sendMessage(message, options);
  if (!advisory) { native(); return; }
  offerWakeConsumer({
    bus: pi.events as unknown as WakeConsumerEventBus,
    source: "pi-herdsman",
    kind: advisory.kind,
    id: advisory.id,
    sessionId: advisory.sessionId,
    metadata: advisory.metadata,
    dispatchGuidance: advisory.dispatchGuidance,
    isCurrent: advisory.isCurrent,
    deliver: native,
    onError: advisory.onError,
  });
}
