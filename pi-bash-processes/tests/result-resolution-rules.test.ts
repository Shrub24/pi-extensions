// The centralized result-resolution eligibility rule (openspec
// `herdsman-background-handoffs` tasks 2.2-2.3) and the retention keep-rule
// that preserves assignment evidence: pure, deterministic coverage of the
// flush-barrier and incomplete-capture decisions every delivery path shares
// — foreground/wait-owned exit, bounded wait, certified get/stop and CLI
// receipts all call `resultResolutionForDelivery` — plus the pruning filter
// that must never evict an unread assignment-owned result.

import { expect, test } from "bun:test";

import { resultIsResolved, resultResolutionForDelivery, selectPrunableFinishedTasks } from "../extensions/task-result.js";

const observation = (overrides: Partial<Parameters<typeof resultResolutionForDelivery>[0]>) =>
	overrides as Parameters<typeof resultResolutionForDelivery>[0];

test("a flush still settling (finalizing) records nothing: the flushing inspection stays unresolved", () => {
	expect(resultResolutionForDelivery(observation({ readiness: "finalizing", outputComplete: false }))).toBeNull();
	expect(resultResolutionForDelivery(observation({ readiness: "running", outputComplete: false }))).toBeNull();
});

test("a capture that can never certify is delivered as an error, never as a successful result", () => {
	expect(resultResolutionForDelivery(observation({ readiness: "incomplete", outputComplete: false }))).toBe("error");
	expect(resultResolutionForDelivery(observation({ readiness: "terminal", outputComplete: false }))).toBe("error");
	expect(resultResolutionForDelivery(observation({ readiness: "terminal", outputComplete: true, outputError: "log unreadable" }))).toBe("error");
});

test("only a certified terminal capture delivers as delivered", () => {
	expect(resultResolutionForDelivery(observation({ readiness: "terminal", outputComplete: true }))).toBe("delivered");
});

test("resultIsResolved matches the settlement predicate: running never, terminal only with a recorded resolution", () => {
	expect(resultIsResolved({ status: "running", resultResolution: "delivered" as const })).toBe(false);
	expect(resultIsResolved({ status: "completed" })).toBe(false);
	expect(resultIsResolved({ status: "completed", resultResolution: "error" as const })).toBe(true);
	expect(resultIsResolved({ status: "stopped", resultResolution: "delivered" as const })).toBe(true);
});

test("retention never prunes an assignment-owned unresolved result, and still prunes history at the bound", () => {
	const task = (overrides: Record<string, unknown>) => ({
		id: "bg-1",
		status: "completed" as const,
		updatedAt: 100,
		...overrides,
	});
	const ownedUnresolved = task({ id: "bg-owned", assignmentRequestId: "req-1", updatedAt: 1 });
	const ownedResolved = task({ id: "bg-owned-done", assignmentRequestId: "req-1", resultResolution: "delivered", updatedAt: 2 });
	const unassociatedOldest = task({ id: "bg-old", updatedAt: 3 });
	const unassociatedNewer = task({ id: "bg-new", updatedAt: 4 });

	const pruned = selectPrunableFinishedTasks([ownedUnresolved, ownedResolved, unassociatedOldest, unassociatedNewer], { maxFinished: 2 });
	// Four finished tasks, bound 2 — but the owned-unresolved task is excluded
	// from the candidates entirely, so only ONE prune (the oldest genuinely
	// prunable history) comes back. With the owned task counted it would be two.
	expect(pruned.map((candidate) => candidate.id)).toStrictEqual(["bg-owned-done"]);
	expect(pruned.some((candidate) => candidate.id === "bg-owned"), "the owned evidence is never pruned").toBe(false);

	const allOwned = selectPrunableFinishedTasks([ownedUnresolved, ownedResolved], { maxFinished: 0 });
	expect(allOwned.map((candidate) => candidate.id), "resolved owned history is still prunable").toStrictEqual(["bg-owned-done"]);
});
