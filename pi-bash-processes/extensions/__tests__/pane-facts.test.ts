import { expect, test } from "bun:test";
import {
	MAX_LISTED_TASKS,
	createPaneFactsPublisher,
	emptyPaneFacts,
	factValue,
	factsAreEmpty,
	factsArgs,
	paneFacts,
} from "../pane-facts.js";

const task = (id: string, startedAt: number, status: "running" | "completed" = "running") => ({ id, status, startedAt });

test("an idle session has no facts", () => {
	expect(paneFacts([])).toEqual(emptyPaneFacts());
	expect(paneFacts([{ ...task("bg-1", 1_000, "completed"), resultResolution: "delivered" }])).toEqual(emptyPaneFacts());
	expect(factsAreEmpty(emptyPaneFacts())).toBe(true);
	expect(factsAreEmpty(paneFacts([task("bg-1", 1_000)]))).toBe(false);
});

test("running tasks are counted, listed and dated from the oldest", () => {
	expect(paneFacts([task("bg-2", 2_000), task("bg-1", 1_000)])).toEqual({
		pi_bg_running: "2",
		pi_bg_tasks: "bg-2:running,bg-1:running",
		pi_bg_started: new Date(1_000).toISOString(),
	});
});

test("the list is capped while the count stays exact", () => {
	const tasks = Array.from({ length: MAX_LISTED_TASKS + 3 }, (_, index) => task(`bg-${index}`, 1_000 + index));
	const facts = paneFacts(tasks);
	expect(facts.pi_bg_running).toBe(String(MAX_LISTED_TASKS + 3));
	expect(facts.pi_bg_tasks?.split(",")).toHaveLength(MAX_LISTED_TASKS);
});

test("values are terminal-safe, bounded and never empty", () => {
	expect(factValue("a\u0007b\nc")).toBe("a b c");
	expect(factValue("\u001b[31mred\u001b[0m")).toBe("red");
	expect(factValue("x".repeat(200))).toHaveLength(80);
	expect(factValue("   ")).toBeNull();
	expect(factValue(null)).toBeNull();
});

test("facts become tokens, and their absence becomes a clear", () => {
	const args = factsArgs("pane-7", paneFacts([task("bg-1", 1_000)]));
	expect(args.slice(0, 6)).toEqual([
		"pane",
		"report-metadata",
		"pane-7",
		"--source",
		"pi-bash-processes",
		"--ttl-ms",
	]);
	expect(args).toContain("pi_bg_running=1");
	expect(args).toContain("pi_bg_tasks=bg-1:running");
	const cleared = factsArgs("pane-7", emptyPaneFacts());
	expect(cleared.filter((arg) => arg === "--clear-token")).toHaveLength(3);
	expect(cleared.some((arg) => arg.startsWith("--token"))).toBe(false);
});

test("the publisher sends the facts and refreshes them", async () => {
	const sent: string[][] = [];
	const publisher = createPaneFactsPublisher({
		paneId: "pane-1",
		send: async (args) => {
			sent.push(args);
		},
		ttlMs: 20,
	});
	await publisher.update(paneFacts([task("bg-1", 1_000)]));
	expect(sent).toHaveLength(1);
	await new Promise((resolve) => setTimeout(resolve, 40));
	expect(sent.length).toBeGreaterThan(1);
	await publisher.close();
});

test("a failed call is tolerated and the next update retries", async () => {
	let fail = true;
	let attempts = 0;
	const publisher = createPaneFactsPublisher({
		paneId: "pane-2",
		send: async () => {
			attempts += 1;
			if (fail) throw new Error("no herdr");
		},
	});
	await publisher.update(paneFacts([task("bg-1", 1_000)]));
	expect(attempts).toBe(1);
	fail = false;
	await publisher.update(paneFacts([task("bg-1", 1_000)]));
	expect(attempts).toBe(2);
	await publisher.close();
});

test("clearing stops the refresh timer and closing clears the keys", async () => {
	const sent: string[][] = [];
	const publisher = createPaneFactsPublisher({
		paneId: "pane-3",
		send: async (args) => {
			sent.push(args);
		},
		ttlMs: 20,
	});
	await publisher.update(paneFacts([task("bg-1", 1_000)]));
	await new Promise((resolve) => setTimeout(resolve, 40));
	await publisher.update(emptyPaneFacts());
	const afterClear = sent.length;
	await new Promise((resolve) => setTimeout(resolve, 40));
	expect(sent.length).toBe(afterClear);
	await publisher.close();
	expect(sent[sent.length - 1]?.filter((arg) => arg === "--clear-token")).toHaveLength(3);
});

test("closing aborts an in-flight write before it clears", async () => {
	const events: string[] = [];
	const publisher = createPaneFactsPublisher({
		paneId: "pane-4",
		send: (args, signal) =>
			args.includes("--clear-token")
				? Promise.resolve().then(() => {
					events.push("clear");
				})
				: new Promise<void>((_resolve, reject) => {
					events.push("write-start");
					signal.addEventListener("abort", () => {
						events.push("write-aborted");
						reject(new Error("aborted"));
					});
				}),
	});
	void publisher.update(paneFacts([task("bg-1", 1_000)]));
	await publisher.close();
	expect(events, "a stale write can never land after the shutdown clear").toEqual(["write-start", "write-aborted", "clear"]);
});
