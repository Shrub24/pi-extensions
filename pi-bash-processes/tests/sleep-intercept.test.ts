import { expect, test } from "bun:test";

import { matchSleepIntercept } from "../extensions/sleep-intercept.js";

const match = (command: string) => matchSleepIntercept(command);

test("a sleep followed only by managed-log reads is intercepted", () => {
	const result = match("sleep 30 && tail -n 20 /tmp/kendex-pi-bg/bg-7-123.log");
	expect(result?.sleepSeconds).toBe(30);
	expect(result?.remainder).toBe("tail -n 20 /tmp/kendex-pi-bg/bg-7-123.log");
});

test("multi-segment reads after the sleep are all kept", () => {
	const result = match("sleep 60 && cat /tmp/bg-1.log; grep -c error /tmp/bg-1.log");
	expect(result?.sleepSeconds).toBe(60);
	expect(result?.remainder).toBe("cat /tmp/bg-1.log && grep -c error /tmp/bg-1.log");
});

test("reads piped into reads count as pure reads", () => {
	expect(match("sleep 10 && cat /tmp/bg-2.log | tail -5")?.sleepSeconds).toBe(10);
});

test("a bare sleep is pacing, not a poll, and is left alone", () => {
	expect(match("sleep 30")).toBeNull();
});

test("sub-threshold sleeps are left alone", () => {
	expect(match("sleep 2 && tail -1 /tmp/bg-3.log")).toBeNull();
});

test("a non-read segment keeps the command intact", () => {
	expect(match("sleep 30 && rm -rf /tmp/x")).toBeNull();
	expect(match("sleep 30 && bun run test")).toBeNull();
	expect(match("sleep 30 && cat /tmp/bg-4.log && nix build")).toBeNull();
});

test("redirection, substitution, backgrounding and loops fail open", () => {
	expect(match("sleep 30 && cat /tmp/bg-5.log > /tmp/copy")).toBeNull();
	expect(match("sleep 30 && cat $(echo /tmp/bg-6.log)")).toBeNull();
	expect(match("sleep 30 && cat /tmp/bg-8.log &")).toBeNull();
	expect(match("sleep 30 && while true; do cat /tmp/bg-9.log; done")).toBeNull();
	expect(match("nohup sleep 30 && cat /tmp/bg-10.log")).toBeNull();
	// `2>/dev/null` is the one allowed redirect: discarding stderr cannot
	// change what the read returns, and agents append it habitually.
	expect(match("sleep 45; tail -12 /tmp/bg-13.log 2>/dev/null")?.remainder).toBe("tail -12 /tmp/bg-13.log 2>/dev/null");
	expect(match("sleep 30 && cat /tmp/bg-14.log 2>/dev/null")).not.toBeNull();
	// stdout redirects still fail open.
	expect(match("sleep 30 && cat /tmp/bg-15.log 1>/dev/null")).toBeNull();
	// Unit suffixes are real coreutils syntax agents write (90s, 1h seen in
	// session history); they parse to seconds.
	expect(match("sleep 90s && cat /tmp/bg-16.log")?.sleepSeconds).toBe(90);
	expect(match("sleep 1h && cat /tmp/bg-17.log")?.sleepSeconds).toBe(3600);
	expect(match("sleep 2m && cat /tmp/bg-18.log")?.sleepSeconds).toBe(120);
	// Non-plain tokens still fail open.
	expect(match("sleep $WAIT && cat /tmp/bg-19.log")).toBeNull();
	expect(match("sleep 0.5 && cat /tmp/bg-20.log")).toBeNull();
});

test("the sleep must lead the command", () => {
	expect(match("tail -1 /tmp/bg-11.log && sleep 30")).toBeNull();
	expect(match("echo hi; sleep 30 && cat /tmp/bg-12.log")).toBeNull();
});
