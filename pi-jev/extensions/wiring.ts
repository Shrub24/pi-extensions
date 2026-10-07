/*
 * Wiring: turn the Pi lifecycle into the calls the judge path needs.
 *
 * Everything here is about *when* things happen — which session is ours, which
 * service object is current, when a notice can be shown — and nothing about
 * what a verdict should be. It is separated from the extension entry point so
 * the same code runs against a fake bus in a test and a real one in a session.
 *
 * The two rules it exists to enforce:
 *
 *   - A registration follows the *service object*, not the session id. A
 *     `/reload` publishes a new service under the same id, and a link held
 *     against the old one would decide nothing while looking registered.
 *   - Registration is idempotent across the repeat `permissions:ready`
 *     emission the provider documents (it fires at `session_start` and again at
 *     the first `before_agent_start`), because a second registration under one
 *     name throws.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ConversationFacts } from "./action-pack.js";
import { createAuthorizerRuntime } from "./authorizer-runtime.js";
import { configConversation, sessionSources } from "./conversation.js";
import { MAX_QUESTIONS_PER_REQUEST, readSettingsFile, resolveConfig } from "./config.js";
import type { JevConfig } from "./config.js";
import type { DecisionLog } from "./decision-log.js";
import { RECORD_VERSION } from "./decision-record.js";
import type { DecisionRecord, EventRecord } from "./decision-record.js";
import { createNudgeDelivery } from "./nudges.js";
import type { NudgeDelivery } from "./nudges.js";
import { installPack, registerSubagentConsumer } from "./consumers.js";
import type { Nudge } from "./consumers.js";
import { acquireCore, acquireLog, logSink } from "./registry.js";
import type { CoreLease } from "./registry.js";
import {
	createSeamLocator,
	PERMISSIONS_DECISION_CHANNEL,
	PERMISSIONS_READY_CHANNEL,
	readDecisionEvent,
	readReadyEvent,
} from "./gotgenes.js";
import type { SeamLocator } from "./gotgenes.js";
import { budgetFrom, createJevClient } from "./jev.js";
import type { JevClient } from "./jev.js";
import type { PermissionsService } from "./types.js";
import type { ToolPolicy } from "./tool-policy.js";
import { loadToolPolicy } from "./tool-policy.js";

export interface WiringDeps {
	config?: JevConfig;
	log?: DecisionLog;
	jev?: JevClient;
	locator?: SeamLocator;
	now?: () => Date;
	/**
	 * The user's tool policy. Unset means it is loaded from the agent directory
	 * like the intent entry loads it — the gate needs the same ruling the
	 * tool_call hook had, or the choice and fit questions would only fire for
	 * calls the hook saw first.
	 */
	policy?: ToolPolicy;
}

/** Register a bus listener; `undefined` when the host has no event bus. */
function subscribe(
	pi: ExtensionAPI,
	channel: string,
	handler: (payload: unknown) => void,
): (() => void) | undefined {
	const events = pi.events as { on?: (channel: string, handler: (payload: unknown) => void) => unknown } | undefined;
	const on = events?.on;
	if (typeof on !== "function") return undefined;
	try {
		const off = on.call(events, channel, handler);
		return typeof off === "function" ? (off as () => void) : () => {};
	} catch {
		return undefined;
	}
}

/** The subset of the service we register into, so a fake can stand in. */
interface RegistrableService {
	registerAuthorizer(name: string, authorize: unknown): () => void;
}

export function wirePermissionAuthorizer(pi: ExtensionAPI, deps: WiringDeps = {}): void {
	const config = deps.config ?? resolveConfig(readSettingsFile());
	// The log and the core are process-wide: a second entry joins the same one
	// rather than opening a second handle on the same file.
	const logLease = deps.log ? undefined : acquireLog(config.logFile);
	const log: DecisionLog = deps.log ?? (logLease?.log as DecisionLog);
	const now = deps.now ?? (() => new Date());
	let ctx: ExtensionContext | undefined;
	const jev =
		deps.jev ??
		createJevClient({
			models: () => (ctx as ExtensionContext).modelRegistry,
			model: config.model,
			timeoutMs: config.timeoutMs,
			...budgetFrom(config),
			...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
		});
	const locator = deps.locator ?? createSeamLocator();

	let sessionId: string | null = null;
	let registeredOn: { service: object; dispose: () => void } | undefined;
	/** This entry's hold on the session's core, taken when the session starts. */
	let lease: CoreLease | undefined;
	const reported = new Set<string>();
	const pending: string[] = [];

	/**
	 * Say a thing once. Before a session exists there is nowhere to say it, so
	 * the message waits for the first context instead of being marked as seen
	 * and lost.
	 */
	const report = (problem: string): void => {
		if (reported.has(problem)) return;
		const ui = ctx?.ui as { notify?: (message: string, level?: string) => void } | undefined;
		if (typeof ui?.notify !== "function") {
			if (!pending.includes(problem)) pending.push(problem);
			return;
		}
		reported.add(problem);
		try {
			ui.notify(problem, "warning");
		} catch {
			// A notice that cannot be shown must not change an authorization.
		}
	};


	/** Lifecycle facts, written so a registration can be confirmed from the log. */
	const writeEvent = (event: string, detail: Record<string, unknown>): void => {
		const record: EventRecord = { record: "event", version: RECORD_VERSION, ts: now().toISOString(), event, detail };
		try {
			log.write(record);
		} catch {
			// Observability only.
		}
	};

	const deliver: NudgeDelivery | undefined =
		config.deliverNudges || config.deliverSubagentNudges ? createNudgeDelivery(pi, () => lease?.core, { cooldownMs: config.nudgeCooldownMs }) : undefined;

	const runtime = createAuthorizerRuntime({
		config,
		core: () => lease?.core,
		conversation: (): ConversationFacts => configConversation(sessionSources(ctx, pi as never), config),
		policy: deps.policy ?? loadToolPolicy().policy,
		report,
		...(deliver ? { deliver } : {}),
	});

	const register = (service: unknown): void => {
		const target = service as RegistrableService;
		if (typeof target?.registerAuthorizer !== "function") return;
		const identity = service as object;
		if (registeredOn?.service === identity) return;
		// Re-registering under one name throws, so the previous link goes first;
		// a stale registration would outlive the service that read it.
		disposeRegistration();
		try {
			const dispose = target.registerAuthorizer(config.authorizerName, runtime.authorize);
			registeredOn = { service: identity, dispose: typeof dispose === "function" ? dispose : () => {} };
			writeEvent("registered", { link: config.authorizerName, mode: config.mode, model: config.model, unavailable: jev.unavailable() ?? null, sessionId });
		} catch (error) {
			report(
				`pi-jev: could not register the "${config.authorizerName}" authorizer (${error instanceof Error ? error.message : String(error)}). A link of that name may already be registered.`,
			);
		}
	};

	const disposeRegistration = (): void => {
		const had = registeredOn !== undefined;
		try {
			registeredOn?.dispose();
		} catch {
			// The provider disposes idempotently; a throw here is not fatal.
		}
		registeredOn = undefined;
		if (had) writeEvent("unregistered", { link: config.authorizerName, sessionId });
	};

	const onReady = (payload: unknown): void => {
		const event = readReadyEvent(payload);
		if (!event || event.sessionId === null) return;
		// One process hosts several nodes, each with its own service. Register
		// into the node that runs this session's chain, not a sibling's. When our
		// own id is unavailable there is no keyed target that is certainly ours,
		// so the first node that publishes one is accepted rather than leaving the
		// link unregistered for the whole session.
		if (sessionId !== null && event.sessionId !== sessionId) return;
		const target = event.sessionId;
		void locator.resolve().then((seam) => {
			if (!seam) return;
			const service = seam.getPermissionsService(target) as unknown as PermissionsService | undefined;
			if (service) register(service);
		});
	};

	const onDecision = (payload: unknown): void => {
		const event = readDecisionEvent(payload);
		if (!event) return;
		const record: DecisionRecord = {
			record: "decision",
			version: RECORD_VERSION,
			ts: now().toISOString(),
			requestId: event.requestId,
			resolution: event.resolution,
			result: event.result,
			surface: event.surface,
			value: event.value,
			origin: event.origin,
			matchedPattern: event.matchedPattern,
			agentName: event.agentName,
			forwarded: event.forwarded,
		};
		try {
			log.write(record);
		} catch {
			// Never a reason to fail a decision that already happened.
		}
	};

	const offReady = subscribe(pi, PERMISSIONS_READY_CHANNEL, onReady);
	const offDecision = subscribe(pi, PERMISSIONS_DECISION_CHANNEL, onDecision);
	if (!offReady || !offDecision) {
		report(
			"pi-jev: this host exposes no extension event bus, so the permission system's service cannot be reached and every ask is deferred to you.",
		);
	}
	pi.on("session_start", (_event, context) => {
		ctx = context;
		try {
			sessionId = (context.sessionManager as { getSessionId?: () => string | undefined }).getSessionId?.() ?? null;
		} catch {
			sessionId = null;
		}
		if (sessionId === null) {
			report(
				"pi-jev: this session exposed no id, so the permission system's service cannot be resolved and every ask is deferred to you.",
			);
		}
		for (const problem of [...pending]) report(problem);
		// The core belongs to the session: the first entry to see one creates it and
		// installs the pack, and every later entry joins what it made.
		if (sessionId !== null && !lease) {
			lease = acquireCore({
				sessionId,
				options: {
					ask: (state, questions, askOptions) => jev.ask(state, questions, askOptions),
					record: logSink({ log, now, mode: config.mode, model: jev.model }),
					maxQuestionsPerRequest: MAX_QUESTIONS_PER_REQUEST,
					flushGapMs: config.queueFlushGapMs,
					// The core owns no real timer: the host supplies one, so the gap is a
					// setting rather than a property of the module graph.
					schedule: (run, ms) => {
						const timer = setTimeout(run, ms);
						return () => clearTimeout(timer);
					},
				},
				setup: (core) => {
					installPack(core, config);
					// The orchestrator's consumer rides this core too: subagent
					// questions read the forwarded-ask facts, so a local ask drops
					// them from the flush. A violation is a steering sentence for the
					// orchestrator — the party that can redirect or retire a child.
					registerSubagentConsumer(core, { config, ...(deliver ? { deliver } : {}) });
				},
			});
		}
		// A local resolution, no request: the user learns the judge is unusable
		// when the session starts, rather than from a silent run of deferrals.
		void jev
			.probe()
			.then(() => {
				const unavailable = jev.unavailable();
				if (unavailable) report(`pi-jev: ${unavailable} Every ask is deferred to you.`);
			});
	});

	// `before_agent_start` carries a fresh context and fires after the
	// permission system's own second `permissions:ready`, so a registration
	// missed at startup (an import still resolving) lands afterwards.
	pi.on("before_agent_start", (_event, context) => {
		ctx = context;
	});

	// A turn boundary: anything queued but never sent is asked here, so a consumer
	// that only queued still gets its answers by the end of the turn.
	pi.on("turn_start", () => {
		lease?.setRunning(true);
	});

	pi.on("turn_end", () => {
		lease?.setRunning(false);
		void lease?.core.flushPending().catch(() => {
			// Best-effort: a failure is already recorded as a failed request.
		});
	});

	pi.on("session_shutdown", () => {
		disposeRegistration();
		// The last entry out drops the core, so a finished session leaves nothing
		// behind for the next one to inherit answers from.
		lease?.release();
		lease = undefined;
		logLease?.release();
		for (const off of [offReady, offDecision]) {
			try {
				off?.();
			} catch {
				// The bus is going away with the session either way.
			}
		}
		ctx = undefined;
		sessionId = null;
	});
}
