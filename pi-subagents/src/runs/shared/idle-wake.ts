import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Prompt content for a wake that has to start a run from an idle session. The run
 * must start through `prompt()` so `before_agent_start` prepares it; a plain
 * `sendMessage({ triggerTurn: true })` skips that and lets Pi drop every section
 * extensions contributed from the system prompt on the run's later requests.
 */
export const IDLE_WAKE_PROMPT = "New subagent notification above.";

type WakeMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type WakeOptions = NonNullable<Parameters<ExtensionAPI["sendMessage"]>[1]>;

export interface IdleWakeSender {
	sendMessage: (message: WakeMessage, options?: WakeOptions) => void;
	/** Absent on delivery-only seams; an idle wake then falls back to the busy path. */
	sendUserMessage?: (content: string) => void;
}

/** Read `isIdle()` from the live cached context; a replaced or stale context reads as busy. */
function contextIsIdle(context: ExtensionContext | null | undefined): boolean {
	if (!context) return false;
	try {
		return context.isIdle();
	} catch {
		return false;
	}
}

/**
 * Deliver a wake. When the session is idle the custom message is appended without a
 * trigger and the run starts through `sendUserMessage`, so the prompt lifecycle
 * prepares it. A busy session keeps the caller's options, because a run already in
 * flight carries its prepared options and mid-run steers must not flap.
 */
export function sendIdleWake(
	sender: IdleWakeSender,
	context: ExtensionContext | null | undefined,
	message: WakeMessage,
	busyOptions: WakeOptions,
): void {
	const sendUserMessage = sender.sendUserMessage;
	if (sendUserMessage && contextIsIdle(context)) {
		sender.sendMessage(message, {});
		sendUserMessage(IDLE_WAKE_PROMPT);
		return;
	}
	sender.sendMessage(message, busyOptions);
}
