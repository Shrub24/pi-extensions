/**
 * Local wire contract for the optional wake consumer. Jev stays independently
 * installable; keep these literals and fields aligned with
 * pi-bash-processes/extensions/wake-consumer.ts.
 */
export const WAKE_CONSUMER_PROTOCOL = "pi-wake-consumer/v1";
export const WAKE_CONSUMER_OFFER = "pi-wake-consumer:v1:offer";
export const WAKE_CONSUMER_CLAIM = "pi-wake-consumer:v1:claim";

export type WakeConsumerDecision = "release" | "skip";
export type WakeConsumerMetadata = Record<string, string | number | boolean | null>;

export interface WakeConsumerOffer {
	protocol: typeof WAKE_CONSUMER_PROTOCOL;
	source: "pi-background-tasks" | "pi-herdsman";
	kind: "soft-timeout" | "soft-deadline";
	id: string;
	sessionId: string;
	token: string;
	deadlineMs: number;
	metadata: WakeConsumerMetadata;
	command?: string;
	dispatchGuidance?: string;
}

export interface WakeConsumerClaim {
	protocol: typeof WAKE_CONSUMER_PROTOCOL;
	token: string;
	answer: (resolve: (decision: WakeConsumerDecision) => void) => void;
}

export interface WakeConsumerEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}
