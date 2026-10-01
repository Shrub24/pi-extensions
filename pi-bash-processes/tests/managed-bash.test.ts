import { expect, test } from "bun:test";

import {
	buildManagedBashEnv,
	createForegroundWaiter,
	formatManagedBashCompletionText,
	formatManagedBashRunningText,
	MANAGED_BASH_PI_ENV_KEYS,
	normalizeManagedBashTimeoutSeconds,
	settleForegroundWaiter,
	structuredOutputFor,
} from "../extensions/managed-bash.js";
import { DEFAULT_FOREGROUND_YIELD_MS } from "../extensions/constants.js";

test("foregroundYieldMs default is 20s", () => {
	expect(DEFAULT_FOREGROUND_YIELD_MS).toBe(20_000);
});

// Fast completion / slow yield / one-owner settle, with real timers so the
// exit-vs-yield race resolves through the actual clearTimeout path.
test("exit-vs-yield has one owner: exit wins, yield loses", async () => {
	const waiter = createForegroundWaiter();
	let timerFired = false;
	waiter.resolve = () => {};
	waiter.yieldTimer = setTimeout(() => {
		timerFired = true;
		settleForegroundWaiter(waiter, { exitCode: null, kind: "yielded", status: "running" });
	}, 5);
	expect(settleForegroundWaiter(waiter, { exitCode: 0, kind: "exited", status: "completed" })).toBe(true);
	expect(waiter.outcome).toEqual({ exitCode: 0, kind: "exited", status: "completed" });
	await new Promise((resolve) => setTimeout(resolve, 15));
	expect(timerFired).toBe(false);
	// A retry after the settled outcome delivers nothing.
	expect(settleForegroundWaiter(waiter, { exitCode: null, kind: "yielded", status: "running" })).toBe(false);
	expect(waiter.outcome).toEqual({ exitCode: 0, kind: "exited", status: "completed" });
});

test("exit-vs-yield has one owner: yield wins, late exit loses", async () => {
	const waiter = createForegroundWaiter();
	const outcome = await new Promise((resolve) => {
		waiter.resolve = resolve as (outcome: unknown) => void;
		const timer = setTimeout(() => {
			settleForegroundWaiter(waiter, { exitCode: null, kind: "yielded", status: "running" });
		}, 1);
		timer.unref?.();
		waiter.yieldTimer = timer;
	});
	expect(outcome).toEqual({ exitCode: null, kind: "yielded", status: "running" });
	// Ambiguous late close after the yield must not re-deliver.
	expect(settleForegroundWaiter(waiter, { exitCode: 0, kind: "exited", status: "completed" })).toBe(false);
	expect(waiter.outcome).toEqual({ exitCode: null, kind: "yielded", status: "running" });
});

test("null waiter and resolved waiter never deliver", () => {
	expect(settleForegroundWaiter(null, { exitCode: 0, kind: "exited", status: "completed" })).toBe(false);
	expect(settleForegroundWaiter(undefined, { exitCode: 0, kind: "exited", status: "completed" })).toBe(false);
	const waiter = createForegroundWaiter();
	waiter.settled = true;
	expect(settleForegroundWaiter(waiter, { exitCode: 0, kind: "exited", status: "completed" })).toBe(false);
});

// Bash `timeout` stays a hard runtime in seconds; never a soft yield.
test("timeout normalization preserves hard-runtime contract", () => {
	expect(normalizeManagedBashTimeoutSeconds(30)).toBe(30);
	expect(normalizeManagedBashTimeoutSeconds(0.5)).toBe(0.5);
	expect(normalizeManagedBashTimeoutSeconds(0)).toBe(0);
	expect(normalizeManagedBashTimeoutSeconds(undefined)).toBe(0);
	expect(normalizeManagedBashTimeoutSeconds(Number.NaN)).toBe(0);
	expect(normalizeManagedBashTimeoutSeconds(-5)).toBe(0);
	expect(normalizeManagedBashTimeoutSeconds("30")).toBe(0);
});

// PI env: inherited values are inherited, the five session keys come only
// from the live session, and the input object is never mutated.
test("managed bash env carries PI_* session values without persisting them", () => {
	const base = {
		HOME: "/home/user",
		PATH: "/usr/bin",
		PI_MODEL: "stale-model",
		PI_SESSION_ID: "stale-session",
	};
	const env = buildManagedBashEnv(base, {
		model: "live-model",
		provider: "live-provider",
		reasoningLevel: "high",
		sessionFile: "/tmp/session.jsonl",
		sessionId: "live-session",
	});
	expect(env.PI_SESSION_ID).toBe("live-session");
	expect(env.PI_SESSION_FILE).toBe("/tmp/session.jsonl");
	expect(env.PI_PROVIDER).toBe("live-provider");
	expect(env.PI_MODEL).toBe("live-model");
	expect(env.PI_REASONING_LEVEL).toBe("high");
	expect(env.HOME).toBe("/home/user");
	expect(base.PI_SESSION_ID).toBe("stale-session");
	expect(base.PI_MODEL).toBe("stale-model");
	for (const key of MANAGED_BASH_PI_ENV_KEYS) expect(key in buildManagedBashEnv({}, {})).toBe(false);
});

// Fast path is truthful completion; slow path is Running, not success.
test("completion text is truthful, running text forbids polling", () => {
	const completion = formatManagedBashCompletionText({
		elapsedText: "0.2s",
		id: "bg-1",
		logFile: "/tmp/bg-1.log",
		outputTail: "hello",
		statusText: "completed (exit 0)",
	});
	expect(completion).toContain("hello");
	expect(completion).toContain("completed (exit 0)");
	expect(completion).not.toContain("exit 0), exit 0");
	expect(completion).not.toContain("Running");

	const running = formatManagedBashRunningText({
		elapsedText: "10s",
		id: "bg-2",
		logFile: "/tmp/bg-2.log",
		outputTail: "",
		pid: 4242,
	});
	expect(running).toContain("Running bg-2");
	expect(running).toContain('bg_task action:"wait"');
	expect(running).toContain("Do not poll it");
	expect(running).toContain("end the turn");
	expect(running).toContain("the exit wake arrives with an output tail");
	expect(running).not.toMatch(/success|completed|exited/i);
});

// The structured result of a finished command must never claim more than the
// caller can back: an exit code it does not have, or an output the task log
// does not hold.
test("structured output carries a real exit code and the log's own truncation", () => {
	const log = "/tmp/bg-1.log";
	const structured = structuredOutputFor(
		{ logFile: log, outputBytes: 3, read: { output: "hi\n", truncated: false }, text: "hi\n" },
		0,
		1234,
	);
	expect(structured).toEqual({ output: "hi\n", truncated: false, exit_code: 0, wall_time_seconds: 1.2 });

	// Truncated by the structured cap: the log holds the whole output, so it is
	// named as such, as Pi's own bash does.
	const capped = structuredOutputFor(
		{ logFile: log, outputBytes: 4_000_000, read: { output: "head\n\n[... x bytes omitted ...]\n\ntail\n", truncated: true }, text: "tail\n" },
		2,
		500,
	);
	expect(capped.truncated).toBe(true);
	expect(capped.full_output_path).toBe(log);
	expect(capped.exit_code).toBe(2);
});

test("structured output without a trustworthy log read never claims completeness", () => {
	const log = "/tmp/bg-2.log";
	// The log writer reports the file unsettled (a failed or stalled last
	// write), so the read is skipped: the bounded text is all there is, the
	// dropped bytes make it truncated, and the log is not offered as the full
	// output because it is missing them.
	const partial = structuredOutputFor({ logFile: log, outputBytes: 900_000, read: null, text: "tail only\n" }, 0, 3000);
	expect(partial.output).toBe("tail only\n");
	expect(partial.truncated).toBe(true);
	expect(partial.full_output_path).toBeUndefined();
	expect(partial.exit_code).toBe(0);

	// The same fallback with nothing dropped: complete, and still no
	// `full_output_path`, which the schema only promises when truncated.
	const whole = structuredOutputFor({ logFile: log, outputBytes: 10, read: null, text: "tail only\n" }, 7, 3000);
	expect(whole).toEqual({ output: "tail only\n", truncated: false, exit_code: 7, wall_time_seconds: 3 });
});
