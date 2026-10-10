import { randomUUID } from "node:crypto";

export const WAKE_CONSUMER_PROTOCOL = "pi-wake-consumer/v1";
export const WAKE_CONSUMER_OFFER = "pi-wake-consumer:v1:offer";
export const WAKE_CONSUMER_CLAIM = "pi-wake-consumer:v1:claim";
export const WAKE_CONSUMER_DECISION_MS = 5_000;

export type WakeConsumerSource = "pi-background-tasks" | "pi-herdsman";
export type WakeConsumerKind = "soft-timeout" | "soft-deadline";
export type WakeConsumerDecision = "release" | "skip";
export type WakeConsumerMetadata = Record<string, string | number | boolean | null>;

export interface WakeConsumerEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface WakeConsumerOffer {
	protocol: typeof WAKE_CONSUMER_PROTOCOL;
	source: WakeConsumerSource;
	kind: WakeConsumerKind;
	id: string;
	sessionId: string;
	token: string;
	/** Relative decision window in milliseconds. */
	deadlineMs: number;
	metadata: WakeConsumerMetadata;
}

/** Emitted synchronously during an offer; answer starts the async decision. */
export interface WakeConsumerClaim {
	protocol: typeof WAKE_CONSUMER_PROTOCOL;
	token: string;
	answer: (resolve: (decision: WakeConsumerDecision) => void) => void;
}

type FinishDecision = WakeConsumerDecision | "fallback" | "invalidated";

/** Unknown kinds are never gateable. A skip suppresses only this advisory. */
export function offerWakeConsumer(input: {
	bus: WakeConsumerEventBus;
	source: WakeConsumerSource;
	kind: string;
	id: string;
	sessionId: string;
	metadata: WakeConsumerMetadata;
	isCurrent: () => boolean;
	deliver: () => void;
	onError?: (reason: string) => void;
}): void {
	const gateable = (input.source === "pi-background-tasks" && input.kind === "soft-timeout")
		|| (input.source === "pi-herdsman" && input.kind === "soft-deadline");
	if (!gateable) {
		input.deliver();
		return;
	}
	const kind = input.kind as WakeConsumerKind;
	const report = (reason: string): void => {
		try {
			input.onError?.(reason.slice(0, 160));
		} catch {
			// Diagnostics must not block wake delivery.
		}
	};
	const isCurrent = (): boolean => {
		try {
			return input.isCurrent();
		} catch {
			return false;
		}
	};

	let metadata: WakeConsumerMetadata;
	try {
		const entries = Object.entries(input.metadata).slice(0, 16);
		for (const [key, value] of entries) {
			if (key.length > 160 || (typeof value === "string" && value.length > 160)) {
				throw new Error("wake metadata exceeds limit");
			}
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
				throw new Error("wake metadata must contain primitives");
			}
			if (typeof value === "number" && !Number.isFinite(value)) {
				throw new Error("wake metadata numbers must be finite");
			}
		}
		metadata = Object.fromEntries(entries);
	} catch (error) {
		report(String(error));
		input.deliver();
		return;
	}

	const offer: WakeConsumerOffer = {
		protocol: WAKE_CONSUMER_PROTOCOL,
		source: input.source,
		kind,
		id: input.id.slice(0, 160),
		sessionId: input.sessionId.slice(0, 160),
		token: randomUUID(),
		deadlineMs: WAKE_CONSUMER_DECISION_MS,
		metadata,
	};
	let claimCount = 0;
	let settled = false;
	let unsubscribe: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const removeListener = (): void => {
		try {
			unsubscribe?.();
		} catch (error) {
			report(String(error));
		}
	};
	const finish = (decision: FinishDecision, reason?: string): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		removeListener();
		if (decision === "skip" || decision === "invalidated" || !isCurrent()) return;
		if (decision === "fallback") report(reason ?? "consumer failure");
		try {
			input.deliver();
		} catch (error) {
			report(String(error));
		}
	};
	const answer = (decision: unknown): void => {
		if (!isCurrent()) return finish("invalidated");
		if (decision !== "release" && decision !== "skip") return finish("fallback", "invalid decision");
		finish(decision);
	};

	try {
		if (!isCurrent()) return;
		unsubscribe = input.bus.on(WAKE_CONSUMER_CLAIM, (raw) => {
			if (!isCurrent()) return finish("invalidated");
			if (!raw || typeof raw !== "object") return;
			const claim = raw as Partial<WakeConsumerClaim>;
			if (claim.protocol !== WAKE_CONSUMER_PROTOCOL || claim.token !== offer.token || typeof claim.answer !== "function") return;
			if (++claimCount !== 1) return finish("fallback", "duplicate claim");
			try {
				claim.answer(answer);
			} catch {
				finish("fallback", "consumer threw");
			}
		});
		input.bus.emit(WAKE_CONSUMER_OFFER, offer);
	} catch (error) {
		removeListener();
		if (claimCount === 0) {
			report(String(error));
			if (isCurrent()) input.deliver();
			return;
		}
		finish(isCurrent() ? "fallback" : "invalidated", String(error));
		return;
	}

	if (claimCount === 0) {
		removeListener();
		input.deliver();
		return;
	}
	if (settled) return;
	timer = setTimeout(() => finish(isCurrent() ? "fallback" : "invalidated", "decision timeout"), WAKE_CONSUMER_DECISION_MS);
	timer.unref?.();
}
