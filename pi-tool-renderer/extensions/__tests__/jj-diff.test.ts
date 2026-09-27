import { expect, test } from "bun:test";
import { isJjDiffCommand, isVcsDiffCommand } from "../tool-renderer/text.js";
import { parseUnifiedDiffOutput } from "../tool-renderer/diff.js";

const JJ_DIFF = `diff --git a/f.txt b/f.txt
new file mode 100644
index 0000000000..a7bc997ebe
--- /dev/null
+++ b/f.txt
@@ -0,0 +1,4 @@
+a
+B
+c
+d
`;

test("jj commands that print a patch are recognised, others are not", () => {
	for (const command of ["jj diff", "jj diff -r @-", "jj --no-pager diff", "jj show", "jj log -p", "jj log --patch -n 3", "cd repo && jj diff --git"]) {
		expect(isJjDiffCommand(command), command).toBe(true);
	}
	for (const command of ["jj status", "jj log", "jj diff --stat", "jj new", "echo jj"]) {
		expect(isJjDiffCommand(command), command).toBe(false);
	}
	expect(isVcsDiffCommand("git diff")).toBe(true);
	expect(isVcsDiffCommand("jj show")).toBe(true);
});

test("jj git-format output parses as a unified diff", () => {
	const files = parseUnifiedDiffOutput(JJ_DIFF);
	expect(files?.length).toBe(1);
	expect(files?.[0]?.path).toBe("f.txt");
	expect(files?.[0]?.diff.additions).toBe(4);
});

test("jj show output with a commit header still parses", () => {
	const output = `Commit ID: ce4b81e\nChange ID: oktopmm\nAuthor: A <a@b.c>\n\n    (no description set)\n\n${JJ_DIFF}`;
	expect(parseUnifiedDiffOutput(output)?.length).toBe(1);
});
