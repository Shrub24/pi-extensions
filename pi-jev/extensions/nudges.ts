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

export function deliverNudges(pi: ExtensionAPI, nudges: readonly Nudge[]): void {
	const send = (pi as { sendMessage?: (message: unknown, options?: unknown) => unknown }).sendMessage;
	if (typeof send !== "function") return;
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
				{ deliverAs: "steer" },
			);
		} catch {
			// A nudge that cannot be delivered must not affect any verdict.
		}
	}
}
