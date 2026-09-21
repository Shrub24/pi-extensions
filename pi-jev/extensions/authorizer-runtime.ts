/*
 * The permission chain link: one `ask` in, one verdict out.
 *
 * The batching, the state, and the records belong to the core (see
 * `decision-core.ts`); this module is the consumer's policy and nothing else:
 *
 *   Failure is a deferral. A link that cannot reach its judge has learned
 *   nothing about the action, and the permission system's own terminal is better
 *   placed to decide than a judge guessing. Every failure path — no key, a
 *   timeout, a malformed answer, a thrown defect — returns `defer`.
 *
 *   Shadow mode records and defers. The would-be verdict is written by the core's
 *   record seam and the permission prompt happens anyway, which is how an edge
 *   gets measured before it is trusted.
 *
 *   Nudges are recorded always and delivered only when a seam is supplied, so an
 *   advisory band spends the agent's attention only after its precision is known.
 */

import { askFactsFrom, callSubject, pendingCallLine } from "./action-pack.js";
import type { ActionContext, ConversationFacts } from "./action-pack.js";
import { applyGuidance } from "./tool-policy.js";
import { askPermission, PERMISSION_CONSUMER } from "./consumers.js";
import type { Nudge } from "./consumers.js";
import type { JevConfig } from "./config.js";
import type { DecisionCore } from "./decision-core.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { Authorizer, AuthorizerLog, AuthorizerVerdict, PermissionQuery, PromptPermissionDetails } from "./types.js";

export type { Nudge };

export interface AuthorizerRuntimeDeps {
	config: JevConfig;
	/**
	 * The session's core, read per ask: it is created when a session starts, and a
	 * wiring that is loaded before any session exists has none yet.
	 */
	core: () => DecisionCore<ActionContext> | undefined;
	/** The session's facts, read fresh for every ask. */
	conversation: () => ConversationFacts;
	/**
	 * The user's tool policy, when one was loaded. The gate resolves its guidance
	 * per ask so the choice and fit questions see the same facts a queued call
	 * carried — the ask rebuilds its facts from the gate's details, and without
	 * this the policy's ruling would only reach the tool_call hook's copy.
	 */
	policy?: ToolPolicy;
	/** Reports a problem once per distinct message; used for the one-time notice. */
	report?: (problem: string) => void;
	/** Where a nudge goes. Unset means signals are recorded and dropped. */
	deliver?: (nudges: readonly Nudge[]) => void;
}

export interface AuthorizerRuntime {
	authorize: Authorizer["authorize"];
}

export function createAuthorizerRuntime(deps: AuthorizerRuntimeDeps): AuthorizerRuntime {
	const { config } = deps;
	const report = deps.report ?? (() => {});
	const reported = new Set<string>();
	const once = (problem: string): void => {
		if (reported.has(problem)) return;
		reported.add(problem);
		report(problem);
	};

	const authorize: Authorizer["authorize"] = async (
		details: PromptPermissionDetails,
		query: PermissionQuery,
		authorizerLog: AuthorizerLog,
	): Promise<AuthorizerVerdict> => {
		try {
			const facts = applyGuidance(askFactsFrom(details, query), deps.policy);
			const core = deps.core();
			if (!core) {
				once("pi-jev: no decision core for this session, so the ask was deferred to you.");
				return { kind: "defer" };
			}
			const context: ActionContext = { facts, conversation: deps.conversation() };
			// The subject is the pending call. Its key is Pi's tool call id, which
			// the tool_call hook also sees, so anything queued about this call lands
			// on the flush that judges it; the permission request id rides along as
			// the correlation id the decision channel joins on.
			const subject = callSubject({ toolCallId: facts.toolCallId, requestId: facts.requestId, correlationId: facts.requestId });

			const outcome = await askPermission({ config, core, context, subject });
			const misconfigured = outcome.errors.find((error) => error.code === "configuration");
			if (misconfigured) once(`pi-jev: no usable judge (${misconfigured.message}). Every ask is deferred to you.`);
			const returned = config.mode === "live" ? outcome.verdict : ({ kind: "defer" } as AuthorizerVerdict);

			authorizerLog.review("pi-jev.judged", {
				requestId: facts.requestId,
				consumer: PERMISSION_CONSUMER,
				mode: config.mode,
				would: outcome.verdict.kind,
				verdict: returned.kind,
				reused: outcome.reused.length,
				requests: outcome.requests,
				bands: outcome.bands
					.map((band) => `${band.id}[${band.role}]=${band.band}${band.probability === null ? (band.level === null ? "" : `#${band.level}`) : `(${band.probability.toFixed(2)})`}`)
					.join(" "),
			});

			if (outcome.nudges.length > 0 && deps.deliver) {
				try {
					deps.deliver(outcome.nudges);
				} catch {
					// A nudge that cannot be delivered is not a reason to change a verdict.
				}
			}

			return returned;
		} catch (error) {
			// Anything reaching here is a defect in this package or a malformed
			// ask. Neither is knowledge about the action, so the ask goes on.
			const message = error instanceof Error ? error.message : String(error);
			once(`pi-jev: judge failed (${message}); the ask was deferred.`);
			try {
				authorizerLog.debug("pi-jev.error", { message });
			} catch {
				// The log seam is the caller's; a throwing log must not decide an ask.
			}
			return { kind: "defer" };
		}
	};

	return { authorize };
}

/** The pending-call line a refusal carries, for consumers phrasing their own denial. */
export function pendingCall(context: ActionContext): string {
	return pendingCallLine(context.facts);
}
