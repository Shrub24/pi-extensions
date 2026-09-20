/*
 * Structural mirrors of the two third-party seams this package talks to.
 *
 * Neither package is a build dependency. Both are resolved at runtime by
 * dynamic import, and what follows is the subset of their public shapes this
 * package actually reads. They are copied from the versions named below, so a
 * consumer compiled against a different major gets a defensive read rather
 * than a type error:
 *
 *   @gotgenes/pi-permission-system 33.0.1
 *     src/authority/authorizer.ts        Authorizer, AuthorizerVerdict
 *     src/service.ts                     PermissionsService, PermissionQuery, AuthorizerLog
 *     src/service/permission-events.ts   PermissionsReadyEvent, PermissionDecisionEvent
 *     src/authority/permission-prompter.ts     PromptPermissionDetails
 *     src/presentation/prompt-payload.ts       PromptRequestFacts, PromptPayload
 *
 *   pi-typesafe 0.6.0
 *     src/ask.ts, src/client.ts, src/schema.ts
 *
 * The permission system's own doc comment states the intent of the first
 * mirror: "fields may be added, but existing fields will not be removed or
 * renamed without a semver-major version bump". Every read below is therefore
 * field-by-field with a fallback, never a cast-and-dereference.
 */

// ── @gotgenes/pi-permission-system ─────────────────────────────────────────

/**
 * A non-terminal chain link's ruling on an `ask`.
 *
 * `deny` carries an optional teaching reason the invoking model sees; `defer`
 * passes the ask to the next link, and the chain ends at a terminal that
 * always decides. Our authorizer returns `defer` for every failure and, in
 * shadow mode, for every outcome.
 */
export type AuthorizerVerdict =
	| { kind: "allow" }
	| { kind: "deny"; reason?: string }
	| { kind: "defer" };

/** The review-log seam injected at `authorize` time. */
export interface AuthorizerLog {
	review(event: string, details?: Record<string, unknown>): void;
	debug(event: string, details?: Record<string, unknown>): void;
}

export interface PermissionCheckResult {
	toolName: string;
	state: "allow" | "deny" | "ask";
	reason?: string;
	matchedPattern?: string;
	source: string;
	origin?: string;
}

/**
 * The narrow, read-only projection of the permission service handed to a chain
 * link: enough to consult the deterministic engine at gate parity, and no
 * registration surface.
 */
export interface PermissionQuery {
	checkPermission(
		surface: string,
		value?: string,
		agentName?: string,
	): PermissionCheckResult;
	getToolPermission(
		toolName: string,
		agentName?: string,
	): "allow" | "deny" | "ask";
}

/** The invariant core of an ask, verbatim from the prompt payload. */
export interface PromptRequestFacts {
	readonly requester: {
		readonly agentName: string | null;
		readonly forwarded: boolean;
		readonly sessionId: string | null;
	};
	readonly surface: string;
	readonly toolName: string | null;
	readonly invokedToolName: string | null;
	readonly value: string;
	readonly matchedPattern: string | null;
	readonly commandContext: string | null;
	readonly executedUnit: string | null;
}

export interface PromptPayload {
	readonly kind: string;
	readonly request: PromptRequestFacts;
	readonly evidence: readonly {
		label: string;
		text: string;
		detail: string | null;
	}[];
	readonly annotations: readonly { source: string; text: string }[];
}

export interface PromptPermissionDetails {
	requestId: string;
	source: string;
	agentName: string | null;
	payload: PromptPayload;
	toolCallId?: string;
	toolName?: string;
	skillName?: string;
	path?: string;
	command?: string;
	target?: string;
	toolInputPreview?: string;
	surface?: string | null;
	value?: string | null;
	forwarding?: {
		requesterAgentName: string | null;
		requesterSessionId: string | null;
	};
}

/** Payload of `permissions:ready`; fires at least once per session. */
export interface PermissionsReadyEvent {
	sessionId: string | null;
	adjudicatesLocally: boolean;
}

/**
 * Payload of `permissions:decision`: the ground truth a shadow record is
 * labelled with. `resolution` names how the decision was reached, which is what
 * separates a human's answer from an automatic one.
 */
export interface PermissionDecisionEvent {
	requestId: string;
	surface: string;
	value: string;
	result: "allow" | "deny";
	resolution: string;
	origin: string | null;
	agentName: string | null;
	matchedPattern: string | null;
	forwarding?:
		| {
				requesterAgentName: string | null;
				requesterSessionId: string | null;
			}
		| null;
}

/** The registration surface of the session's permission service. */
export interface PermissionsService extends PermissionQuery {
	/**
	 * Register a named live-authority chain link. Registration alone grants no
	 * authority: the operator names the link in `authorizerChain` first. A
	 * second registration under the same name throws; the returned disposer
	 * unregisters.
	 */
	registerAuthorizer(
		name: string,
		authorize: Authorizer["authorize"],
	): () => void;
}

export interface Authorizer {
	authorize(
		details: PromptPermissionDetails,
		query: PermissionQuery,
		log: AuthorizerLog,
	): Promise<AuthorizerVerdict>;
}

// ── pi-typesafe ────────────────────────────────────────────────────────────

export interface NoulQuestion {
	type: "noul";
	instructions?: string;
	criteria?: { true?: unknown; false?: unknown };
}

export interface ChoiceQuestion {
	type: "choice";
	instructions?: string;
	criteria: Record<string, unknown>;
}

export interface ScoreQuestion {
	type: "score";
	instructions?: string;
	criteria: unknown[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export type JevAnswer =
	| { type: "noul"; noul: number }
	| {
			type: "choice";
			choice: string;
			probabilities: Record<string, number>;
			confidence: number;
	  }
	| {
			type: "score";
			score: number;
			legend: string;
			probabilities: Record<string, number>;
			confidence: number;
	  };

export interface JevUsage {
	input_tokens: number;
	output_tokens: number;
}

export interface JevRequest {
	state: unknown;
	questions: JevQuestions;
	model?: string;
}

export interface JevEvaluation {
	answers: Record<string, JevAnswer>;
	model: string;
	usage: JevUsage;
	elapsedMs: number;
}

/**
 * The narrow judge seam: anything with pi-typesafe's `evaluate`. Tests pass a
 * stub; the session passes the client `createTypeSafe` builds.
 */
export interface JevJudge {
	evaluate(
		request: JevRequest,
		options?: { signal?: AbortSignal },
	): Promise<JevEvaluation>;
}

/**
 * `ask`'s settled result: a failure is a value carrying pi-typesafe's own
 * error code, never a thrown error. The codes are
 * `configuration | validation | budget | aborted | timeout | http |
 * connection | response`.
 */
export type JevAskAnswer =
	| {
			ok: true;
			answers: Record<string, JevAnswer>;
			model: string;
			usage: JevUsage;
			elapsedMs: number;
	  }
	| { ok: false; error: string; errorCode?: string };
