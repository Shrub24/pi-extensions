import { expect, test } from "bun:test";
import { DEFAULT_SOFT_TIMEOUT_MS } from "../extensions/constants.js";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

interface SoftState {
	status: string;
	exitNotified: boolean;
	expiresAt: number | null;
	softExpiresAt: number | null;
	softTimeoutMs: number | null;
	softTimeoutNotified: boolean | null;
}

interface SoftFixtureResult {
	spawn: { resultId: string };
	soft?: Record<string, unknown>;
	final: SoftState;
	remainingTimers: unknown[];
	unexpected: unknown[];
	messages: unknown[];
}

const softState = (result: SoftFixtureResult): SoftState => result.final;
const soft = (result: SoftFixtureResult): Record<string, unknown> => {
	if (!result.soft) throw new Error(`spawn_fixture.soft_scenario_missing=${result.soft}`);
	return result.soft;
};

/**
 * Soft expiry: one progress-review steer for that interval, the process is
 * never signalled, the task stays running, the next interval is measured from
 * the delivered review, and the later real exit still delivers its wake.
 */
test("soft expiry reviews once, never stops the process, and keeps the later exit wake", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-expiry", softTimeoutMs: 60_000 }) as SoftFixtureResult;
	const { atSpawn, afterWake, afterExit } = soft(result) as {
		atSpawn: { timers: number; state: SoftState };
		afterWake: { state: SoftState; wakes: number; text: string; signals: unknown[]; softTimers: number; exitWakes: number };
		afterExit: { state: SoftState; exitWakes: number; softWakes: number };
	};
	expect(atSpawn, "one soft timer armed at spawn, task running").toStrictEqual({
		timers: 1,
		state: { status: "running", exitNotified: false, expiresAt: null, softExpiresAt: 1_700_000_060_000, softTimeoutMs: 60_000, softTimeoutNotified: false },
	});
	expect(afterWake.state.status, "the task is still running; a soft reminder never stops it").toBe("running");
	expect(afterWake.signals, "no SIGTERM/SIGKILL was sent").toEqual([]);
	expect(afterWake.wakes, "exactly one soft reminder in that interval").toBe(1);
	expect(afterWake.softTimers, "the delivered review re-armed exactly one next interval").toBe(1);
	expect(afterWake.state.softExpiresAt, "the next interval is measured from the delivered review").toBe(1_700_000_060_000);
	expect(afterWake.exitWakes, "a reminder is not an exit wake").toBe(0);
	expect(afterWake.text).toContain("still running after");
	// The progress wake carries the same per-task line the completion wakes do:
	// what the task is doing, and that its result is not in hand yet.
	expect(afterWake.text).toContain("bg-1 · still running · result pending");
	expect(afterWake.text).toContain('bg_task action:"extend"');
	expect(afterWake.text).toContain('bg_task action:"stop"');
	expect(afterExit.state.status, "the real exit still finalized the task").toBe("completed");
	expect(afterExit.exitWakes, "the later exit wake still fired").toBe(1);
	expect(afterExit.softWakes, "and no second reminder").toBe(1);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * extend clears the fired one-shot latch, re-arms a fresh window from now, and
 * never touches the hard timeoutSeconds budget.
 */
test("extend re-arms a fresh soft window and leaves the hard timeout unchanged", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-extend", softTimeoutMs: 60_000, extendSoftTimeoutMs: 120_000, timeoutSeconds: 3600 }) as SoftFixtureResult;
	const { firstWake, afterExtend, secondWake, afterExit } = soft(result) as {
		firstWake: { state: SoftState; wakes: number; softTimers: number; wakeText: string; signals: unknown[] };
		afterExtend: { action: string; state: SoftState; softTimers: number; hardTimers: number; text: string };
		secondWake: { state: SoftState; wakes: number; text: string; signals: unknown[]; hardTimers: number };
		afterExit: { state: SoftState; exitWakes: number; softWakes: number };
	};
	expect(firstWake.wakes, "the original deadline fired once").toBe(1);
	expect(firstWake.softTimers, "the delivered review re-armed the next interval").toBe(1);
	expect(firstWake.wakeText, "the first wake surfaces the hard backstop time").toContain("Hard timeout backstop");
	expect(firstWake.signals, "and sent no signal").toEqual([]);
	expect(afterExtend.action, "the extend action is reported").toBe("extend");
	expect(afterExtend.state.softTimeoutNotified, "the one-shot latch was cleared").toBe(false);
	expect(afterExtend.state.softTimeoutMs, "the new window is stored").toBe(120_000);
	expect(afterExtend.state.softExpiresAt, "the deadline is now, not the old one").toBe(1_700_000_120_000);
	expect(afterExtend.softTimers, "exactly one re-armed timer").toBe(1);
	expect(afterExtend.hardTimers, "the hard timeout timer stays armed").toBe(1);
	expect(afterExtend.text).toContain("Hard timeout is unchanged");
	expect(secondWake.wakes, "the extended window fired a second reminder").toBe(2);
	expect(secondWake.signals, "extend never signals the process").toEqual([]);
	expect(secondWake.hardTimers, "hard timer still armed after the second reminder").toBe(1);
	expect(afterExit.state.expiresAt, "hard deadline survived untouched").toBe(1_700_003_600_000);
	expect(afterExit.exitWakes, "the exit still wakes").toBe(1);
	expect(afterExit.softWakes, "still exactly two reminders").toBe(2);
}, SPAWN_FIXTURE_TIMEOUT_MS * 2);

/** extend with softTimeoutMs: 0 disables the reminder entirely. */
test("extend with softTimeoutMs 0 disables further reminders", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-extend", softTimeoutMs: 60_000, extendSoftTimeoutMs: 0 }) as SoftFixtureResult;
	const { afterExtend, secondWake, afterExit } = soft(result) as {
		afterExtend: { state: SoftState; softTimers: number; text: string };
		secondWake: { fired: boolean; state: SoftState; wakes: number };
		afterExit: { softWakes: number };
	};
	expect(afterExtend.state.softTimeoutNotified).toBe(false);
	expect(afterExtend.state.softExpiresAt, "no deadline while disabled").toBeNull();
	expect(afterExtend.softTimers, "no timer armed").toBe(0);
	expect(afterExtend.text).toContain("disabled");
	expect(secondWake.fired, "the disabled window never fires").toBe(false);
	expect(secondWake.wakes, "still only the first reminder").toBe(1);
	expect(afterExit.softWakes, "and no reminder after the exit").toBe(1);
}, SPAWN_FIXTURE_TIMEOUT_MS * 2);

/**
 * A task that exits before its soft deadline never gets a progress reminder — the
 * promise that reminder made transfers to the result it left behind: the finished,
 * unretrieved capture now owns the interval, and its reminder says what is owed.
 */
test("a terminal task emits no soft wake and reminds for the unretrieved result instead", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-terminal", softTimeoutMs: 60_000 }) as SoftFixtureResult;
	const scenario = soft(result) as {
		softWakes: number;
		exitWakes: number;
		reviewWakes: string[];
		timers: { kind: string; ms: number }[];
	};
	expect(scenario.softWakes, "no progress reminder for a finished task").toBe(0);
	expect(scenario.exitWakes, "the exit still woke normally").toBe(1);
	// One wake, naming the task and both ways out; a reminder that only nagged
	// would leave the reader with no sanctioned way to settle it.
	expect(scenario.reviewWakes).toHaveLength(1);
	expect(scenario.reviewWakes[0]).toContain("bg-1 finished, and its result is still unretrieved");
	expect(scenario.reviewWakes[0]).toContain('bg_task action:"get" id: bg-1');
	expect(scenario.reviewWakes[0]).toContain('bg_task action:"clear" ids:["bg-1"]');
	expect(scenario.timers, "the orphan watcher and the re-armed next interval").toEqual([
		{ kind: "interval", ms: 30_000 },
		{ kind: "timeout", ms: 60_000 },
	]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * A restored live task (pid still alive across restart) re-arms exactly one
 * soft reminder from its persisted deadline.
 */
test("a restored live task re-arms its next review interval without double-arming", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-restore", softTimeoutMs: 60_000 }) as SoftFixtureResult;
	const { beforeRestore, afterRestore, afterWake } = soft(result) as {
		beforeRestore: { state: SoftState; softTimers: number };
		afterRestore: { state: SoftState; softTimers: number; timers: { kind: string; ms: number }[] };
		afterWake: { state: SoftState; wakes: number; text: string; signals: unknown[]; shiftedTimers: number; exitWakes: number };
	};
	expect(beforeRestore.softTimers, "one timer before restart").toBe(1);
	expect(afterRestore.state.status, "the task survives the restart as running").toBe("running");
	expect(afterRestore.state.softTimeoutNotified, "the one-shot latch is still false").toBe(false);
	expect(afterRestore.softTimers, "re-armed exactly once after restore").toBe(1);
	expect(afterRestore.timers.filter((timer) => timer.kind === "timeout" && timer.ms === 60_000).length, "no duplicated soft timer after restore").toBe(1);
	expect(afterWake.wakes, "the restored deadline still fires its one reminder").toBe(1);
	expect(afterWake.signals, "and never stops the process").toEqual([]);
	expect(afterWake.shiftedTimers, "one timer for the next interval").toBe(1);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * The delivered marker is persisted: a restart after the reminder fired arms
 * the persisted next interval instead of replaying the deadline that already
 * fired.
 */
test("a restored task whose reminder already fired does not re-wake for that interval", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-restore-notified", softTimeoutMs: 60_000 }) as SoftFixtureResult;
	const { afterWake, afterRestore } = soft(result) as {
		afterWake: { state: SoftState; wakes: number; softTimers: number };
		afterRestore: { state: SoftState; softTimers: number; wakes: number; exitWakes: number };
	};
	expect(afterWake.wakes, "reminder fired before restart").toBe(1);
	expect(afterWake.state.softTimeoutNotified, "the delivered marker persisted").toBe(true);
	expect(afterWake.softTimers, "and the next interval is armed").toBe(1);
	expect(afterRestore.wakes, "restore produced no new reminder").toBe(1);
	expect(afterRestore.softTimers, "restore re-arms exactly the persisted next interval").toBe(1);
	expect(afterRestore.state.softTimeoutNotified, "the delivered marker survived the restore").toBe(true);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * The extension default is the approved 10 minutes, and per-spawn
 * `softTimeoutMs` overrides it (0 disables).
 */
test("spawn schema default is 600000ms and per-spawn override wins", () => {
	const defaulted = runSpawnFixture("spawn-extension.ts", { mode: "spawn", softTimeoutMs: null, defaultSoftTimeoutMs: 600_000 }) as SoftFixtureResult & { spawnSoftState?: SoftState };
	expect(defaulted.spawnSoftState?.softTimeoutMs, "the 10-minute default applies").toBe(DEFAULT_SOFT_TIMEOUT_MS);
	expect(defaulted.spawnSoftState?.softExpiresAt, "deadline = start + default").toBe(1_700_000_000_000 + DEFAULT_SOFT_TIMEOUT_MS);
	expect(defaulted.spawnSoftState?.softTimeoutNotified, "the reminder starts unfired").toBe(false);

	const overridden = runSpawnFixture("spawn-extension.ts", { mode: "spawn", softTimeoutMs: 0 }) as SoftFixtureResult & { spawnSoftState?: SoftState };
	expect(overridden.spawnSoftState?.softTimeoutMs, "0 disables").toBe(0);
	expect(overridden.spawnSoftState?.softExpiresAt, "and arms no deadline").toBeNull();

	const custom = runSpawnFixture("spawn-extension.ts", { mode: "spawn", softTimeoutMs: 45_000 }) as SoftFixtureResult & { spawnSoftState?: SoftState };
	expect(custom.spawnSoftState?.softTimeoutMs, "a per-spawn value passes through").toBe(45_000);
	expect(custom.spawnSoftState?.softExpiresAt, "deadline = start + value").toBe(1_700_000_045_000);
}, SPAWN_FIXTURE_TIMEOUT_MS * 3);

/**
 * A successful review invalidates a reminder that is already armed: the stale
 * timer is discarded, the next interval is measured from the review, and only
 * that interval can produce a wake — a review never leaves behind a second
 * reminder for the deadline it replaced.
 */
test("a review discards an armed stale reminder and starts the interval from the review", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-review-reset", softTimeoutMs: 60_000, extendSoftTimeoutMs: 90_000 }) as SoftFixtureResult;
	const { atSpawn, afterReset, afterWake } = soft(result) as {
		atSpawn: { timers: number; state: SoftState };
		afterReset: { state: SoftState; staleTimers: number; timers: number; text: string };
		afterWake: { state: SoftState; wakes: number; timers: number };
	};
	expect(atSpawn.state, "the first interval is armed at spawn").toStrictEqual({
		status: "running", exitNotified: false, expiresAt: null, softExpiresAt: 1_700_000_060_000, softTimeoutMs: 60_000, softTimeoutNotified: false,
	});
	expect(atSpawn.timers, "one armed reminder").toBe(1);
	expect({ staleTimers: afterReset.staleTimers, timers: afterReset.timers }, "the review replaced the armed reminder instead of adding to it")
		.toStrictEqual({ staleTimers: 0, timers: 1 });
	expect(afterReset.text).toContain("Hard timeout is unchanged");
	expect({ wakes: afterWake.wakes, timers: afterWake.timers, softExpiresAt: afterWake.state.softExpiresAt }, "the new interval fired once and re-armed from its own delivery")
		.toStrictEqual({ wakes: 1, timers: 1, softExpiresAt: 1_700_000_090_000 });
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * Task 3.3: the reminder a task holds is a single one, and it is a reminder
 * about the interval measured from the last review rather than a second parallel
 * timer. Output bursts inside the interval add nothing, a delivered reminder
 * re-arms exactly one in its place, and the second interval is measured from the
 * first delivery.
 */
test("a task holds at most one reminder, and output noise adds none", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "soft-one-reminder", softTimeoutMs: 60_000 }) as SoftFixtureResult;
	const { atSpawn, afterNoise, afterFirst, afterSecond } = soft(result) as {
		atSpawn: { timers: number };
		afterNoise: { timers: number; wakes: number; timerCounts: number[] };
		afterFirst: { timers: number; wakes: number; softExpiresAt: number | null };
		afterSecond: { timers: number; wakes: number };
	};
	expect(atSpawn.timers, "one armed reminder at spawn").toBe(1);
	// Two streams of output per burst, three bursts: never a second timer.
	expect(afterNoise.timerCounts, "output activity neither arms a reminder nor discharges the armed one").toStrictEqual([1, 1, 1]);
	expect({ timers: afterNoise.timers, wakes: afterNoise.wakes }, "output alone produces no reminder").toStrictEqual({ timers: 1, wakes: 0 });
	expect({ timers: afterFirst.timers, wakes: afterFirst.wakes }, "delivery replaced the fired reminder with exactly one rearmed one")
		.toStrictEqual({ timers: 1, wakes: 1 });
	// The fixture clock is frozen, so the delivery instant IS the spawn instant and
	// the re-armed deadline coincides with the original one. That the interval is
	// measured from the delivery rather than from the spawn is pinned where the
	// clock moves: `soft-review-reset` below moves the deadline to
	// 1_700_000_090_000, and `tests/task-result.test.ts` pins the same rule.
	expect(afterFirst.softExpiresAt, "the surviving reminder keeps the deadline its own interval ends on").toBe(1_700_000_060_000);
	expect({ timers: afterSecond.timers, wakes: afterSecond.wakes }, "the rearmed reminder fired once and rearmed again")
		.toStrictEqual({ timers: 1, wakes: 2 });
}, SPAWN_FIXTURE_TIMEOUT_MS);
