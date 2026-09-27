import { expect, test } from "bun:test";

import { emulateTruncation, stripTerminalTruncation } from "../extensions/pipe-strip.js";

const strip = (command: string) => stripTerminalTruncation(command);

test("a terminal tail is stripped with its line count", () => {
	const result = strip("nix build .#memex 2>&1 | tail -20");
	expect(result).toEqual({ command: "nix build .#memex 2>&1", tool: "tail", lines: 20 });
});

test("bare head/tail and -n spacing variants strip too", () => {
	expect(strip("make | head")).toMatchObject({ tool: "head", lines: 10 });
	expect(strip("make | head -n 5")).toMatchObject({ tool: "head", lines: 5 });
	expect(strip("make  | tail -n 3")).toMatchObject({ tool: "tail", lines: 3 });
});

test("anything but a single terminal truncation stays intact", () => {
	expect(strip("cat a | grep x | tail -5")).toBeNull(); // two pipes
	expect(strip("cat a && tail -5 b")).toBeNull(); // && in command
	expect(strip("echo hi | tail -5 &")).toBeNull(); // backgrounded
	expect(strip("cat <<EOF | tail -5")).toBeNull(); // heredoc
	expect(strip("grep x $(ls) | head -3")).toBeNull(); // substitution
	expect(strip("cat a | grep x")).toBeNull(); // not a truncation
	expect(strip("tail -f /var/log/sys.log")).toBeNull(); // no pipe at all
});

test("quoted pipes do not count as pipeline stages", () => {
	expect(strip(`echo "a|b" | tail -2`)).toMatchObject({ tool: "tail", lines: 2 });
});

test("emulation reproduces head and tail on completed text", () => {
	const text = ["1", "2", "3", "4", "5"].join("\n") + "\n";
	expect(emulateTruncation(text, "tail", 2)).toEqual({ text: "4\n5\n", dropped: 3 });
	expect(emulateTruncation(text, "head", 2)).toEqual({ text: "1\n2\n", dropped: 3 });
	expect(emulateTruncation("only\n", "tail", 10)).toEqual({ text: "only\n", dropped: 0 });
});
