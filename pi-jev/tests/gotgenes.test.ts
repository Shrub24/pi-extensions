import { expect, test } from "bun:test";

import { createSeamLocator, PERMISSIONS_DECISION_CHANNEL, PERMISSIONS_READY_CHANNEL, readDecisionEvent, readReadyEvent } from "../extensions/gotgenes.js";

const PROVIDER = {
	getPermissionsService: (sessionId: string) => (sessionId === "s1" ? ({ registerAuthorizer: () => () => {} } as never) : undefined),
	PERMISSIONS_READY_CHANNEL: "permissions:ready",
	PERMISSIONS_DECISION_CHANNEL: "permissions:decision",
};

test("an absent permission system is remembered, not retried per ask", async () => {
	let loads = 0;
	let clock = 0;
	const locator = createSeamLocator({
		load: async () => {
			loads++;
			throw new Error("Cannot find package '@gotgenes/pi-permission-system'");
		},
		now: () => clock,
	});
	expect(await locator.resolve()).toBeUndefined();
	expect(await locator.resolve()).toBeUndefined();
	expect(loads).toBe(1);

	clock += 30_001;
	expect(await locator.resolve()).toBeUndefined();
	expect(loads).toBe(2);
});

test("a module that is not the permission system is treated as absent", async () => {
	const locator = createSeamLocator({ load: async () => ({ something: "else" }), now: () => 0 });
	expect(await locator.resolve()).toBeUndefined();
});

test("the provider's own channel names win over our copies", async () => {
	const custom = createSeamLocator({
		load: async () => ({ ...PROVIDER, PERMISSIONS_READY_CHANNEL: "permissions:ready:v2", PERMISSIONS_DECISION_CHANNEL: 42 }),
		now: () => 0,
	});
	const seam = await custom.resolve();
	expect(seam?.readyChannel).toBe("permissions:ready:v2");
	// A channel constant that is not a string falls back to the documented name.
	expect(seam?.decisionChannel).toBe(PERMISSIONS_DECISION_CHANNEL);

	const plain = createSeamLocator({ load: async () => PROVIDER, now: () => 0 });
	const resolved = await plain.resolve();
	expect(resolved?.getPermissionsService("s1")).toBeDefined();
	expect(resolved?.getPermissionsService("other")).toBeUndefined();
	expect(PERMISSIONS_READY_CHANNEL).toBe("permissions:ready");
});

test("a ready payload is narrowed to its facts", () => {
	expect(readReadyEvent({ sessionId: "s1", adjudicatesLocally: true })).toEqual({ sessionId: "s1", adjudicatesLocally: true });
	expect(readReadyEvent({ sessionId: null, adjudicatesLocally: false })).toEqual({ sessionId: null, adjudicatesLocally: false });
	expect(readReadyEvent({ adjudicatesLocally: true })).toEqual({ sessionId: null, adjudicatesLocally: true });
	expect(readReadyEvent({ sessionId: 7 })).toBeUndefined();
	expect(readReadyEvent("nope")).toBeUndefined();
	expect(readReadyEvent(null)).toBeUndefined();
});

test("a decision payload is narrowed, and forwarding is reduced to a flag", () => {
	const full = readDecisionEvent({
		requestId: "req-1",
		surface: "bash",
		value: "rm -rf build",
		result: "deny",
		resolution: "user_denied",
		origin: "project",
		matchedPattern: "rm *",
		agentName: "worker",
		forwarding: { requesterAgentName: "worker", requesterSessionId: "s2" },
	});
	expect(full).toEqual({
		requestId: "req-1",
		surface: "bash",
		value: "rm -rf build",
		result: "deny",
		resolution: "user_denied",
		origin: "project",
		matchedPattern: "rm *",
		agentName: "worker",
		forwarded: true,
	});

	const minimal = readDecisionEvent({ requestId: "req-2", result: "allow", resolution: "user_approved", forwarding: null });
	expect(minimal?.forwarded).toBe(false);
	expect(minimal?.surface).toBe("");
	expect(minimal?.origin).toBeNull();

	// A missing resolution is recorded as unknown rather than dropped: the ask
	// record still needs its label decided, and "unknown" yields no label.
	expect(readDecisionEvent({ requestId: "req-3", result: "allow" })?.resolution).toBe("unknown");
	expect(readDecisionEvent({ result: "allow" })).toBeUndefined();
	expect(readDecisionEvent({ requestId: "req-4", result: "maybe" })).toBeUndefined();
	expect(readDecisionEvent(undefined)).toBeUndefined();
});
