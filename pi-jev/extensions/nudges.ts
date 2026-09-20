/*
 * Nudge delivery: the one place that talks to the agent.
 *
 * A custom message delivered as a steer — it lands after the current tool batch
 * and shapes the next call, and it stays out of the user's own message stream.
 * pi-warden measured steers acted on within seconds in the same session, and
 * their 51 fixture-shaped credential warnings are what happens when a nudge fires
 * on something that did not need attention; hence a shadow record of every signal
 * and delivery switches that default to off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Nudge } from "./consumers.js";

export interface DeliverOptions {
	/**
	 * `steer` lands after the current tool batch; `followUp` waits for the agent
	 * to finish, and with `triggerTurn` wakes an idle agent — the orchestrator's
	 * check-in wake. Default `steer`, for nudges sent while a human may be
	 * waiting on a gate.
	 */
	mode?: "steer" | "followUp";
	triggerTurn?: boolean;
}

export function deliverNudges(pi: ExtensionAPI, nudges: readonly Nudge[], options: DeliverOptions = {}): void {
	const send = (pi as { sendMessage?: (message: unknown, options?: unknown) => unknown }).sendMessage;
	if (typeof send !== "function") return;
	const delivery = { deliverAs: options.mode ?? "steer", ...(options.triggerTurn ? { triggerTurn: true } : {}) } as const;
	for (const nudge of nudges) {
		try {
			send.call(
				pi,
				{
					customType: "pi-jev",
					content: nudge.text,
					display: true,
					details: { source: nudge.source, role: nudge.role, measured: nudge.measured },
				},
				delivery,
			);
		} catch {
			// A nudge that cannot be delivered must not affect any verdict.
		}
	}
}
