/*
 * Nudge delivery: the one place that talks to the agent.
 *
 * A custom message delivered as a steer — it lands after the current tool batch
 * and shapes the next call, and it stays out of the user's own message stream.
 * pi-warden measured steers acted on within seconds in the same session, and
 * their 51 fixture-shaped credential warnings are what happens when a nudge fires
 * on something that did not need attention; hence a shadow record of every signal
 * and delivery switches that default to off.
 *
 * A wake that starts an idle run must not start it with `triggerTurn`: Pi runs
 * that path without `before_agent_start` (earendil-works/pi#5581, #10267), so the
 * run is never prepared with the system-prompt options every extension
 * contributed and its second request rebuilds the prompt from base options,
 * dropping those sections mid-run and re-billing the whole prompt. When the
 * session is idle the nudge is appended without a trigger and the run is started
 * by a short user prompt, which goes through the normal prompt lifecycle. A busy
 * session keeps steering, where the run already carries prepared options.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Nudge } from "./consumers.js";
import { type LedgerOptions, ledgerFor } from "./nudge-ledger.js";

export interface DeliverOptions {
	/**
	 * `steer` lands after the current tool batch; `followUp` waits for the agent
	 * to finish, and with `triggerTurn` wakes an idle agent — the orchestrator's
	 * check-in wake. Default `steer`, for nudges sent while a human may be
	 * waiting on a gate.
	 */
	mode?: "steer" | "followUp";
	triggerTurn?: boolean;
	/**
	 * Whether the session is idle right now. Read only for a `triggerTurn`
	 * delivery: an idle session is woken through a user prompt instead of
	 * `triggerTurn`, which would skip `before_agent_start`. Absent means the
	 * caller cannot tell, and the delivery keeps its previous shape.
	 */
	isIdle?: () => boolean;
}

/**
 * The short prompt that starts an idle session's run. It carries no content of
 * its own — the nudge is the custom message above it — it only routes the wake
 * through `prompt()` so the run is prepared like a user turn.
 */
const IDLE_WAKE_PROMPT = "New pi-jev nudge above.";

export function deliverNudges(pi: ExtensionAPI, nudges: readonly Nudge[], options: DeliverOptions = {}): void {
	const send = (pi as { sendMessage?: (message: unknown, options?: unknown) => unknown }).sendMessage;
	if (typeof send !== "function") return;
	const wake = (pi as { sendUserMessage?: (content: string) => unknown }).sendUserMessage;
	// A stale or replaced context reads as busy, never as a throw: the delivery
	// then keeps the shape it always had. Without a prompt seam there is no awake
	// path, so `triggerTurn` stays the only way to start the run.
	let wakeIdle = false;
	if (nudges.length > 0 && options.triggerTurn === true && typeof wake === "function") {
		try {
			wakeIdle = options.isIdle?.() === true;
		} catch {
			wakeIdle = false;
		}
	}
	const delivery = { deliverAs: options.mode ?? "steer", ...(options.triggerTurn ? { triggerTurn: true } : {}) } as const;
	let delivered = 0;
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
				// An idle wake appends without a trigger; the user prompt below starts
				// the run. Anything else keeps the delivery it always had.
				wakeIdle ? undefined : delivery,
			);
			delivered += 1;
		} catch {
			// A nudge that cannot be delivered must not affect any verdict.
		}
	}
	// Never wake for a batch that reached the session with nothing.
	if (!wakeIdle || delivered === 0) return;
	try {
		wake!.call(pi, IDLE_WAKE_PROMPT);
	} catch {
		// The nudge is already in the session; a failed wake leaves it for the
		// next user turn, which must not affect any verdict either.
	}
}

/**
 * A delivery that goes through the session's ledger: what the consumers call.
 *
 * `ref` is the subject the finding is about — the tool call id behind the ask —
 * and it is what an accumulated reminder names, so "3rd time this session" is
 * followed by the calls being counted. Without a scope (no live session) the
 * ledger is a pass-through.
 */
export type NudgeDelivery = (nudges: readonly Nudge[], ref?: string | null) => void;

export function createNudgeDelivery(
	pi: ExtensionAPI,
	scope: () => object | undefined,
	options: DeliverOptions & LedgerOptions = {},
): NudgeDelivery {
	return (nudges, ref = null) => {
		const admitted = ledgerFor(scope(), options).admit(nudges, ref);
		if (admitted.length > 0) deliverNudges(pi, admitted, options);
	};
}
